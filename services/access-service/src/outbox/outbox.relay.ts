import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT, type OptionalRedis } from '../redis/redis.module';
import { ACCESS_EVENTS_STREAM } from './access-events';

/**
 * Lleva los eventos de la outbox al bus.
 *
 * COMO EVITA PUBLICAR DOS VECES EL MISMO EVENTO CON VARIAS REPLICAS
 * ─────────────────────────────────────────────────────────────────
 * Con `FOR UPDATE SKIP LOCKED`. Cada réplica bloquea el lote que va a
 * publicar y las demás **se saltan** esas filas en lugar de esperarlas,
 * así que dos relays trabajando a la vez se reparten la cola sin
 * coordinarse y sin bloquearse el uno al otro. Es la forma estándar de
 * hacer una cola sobre PostgreSQL y la razón por la que este relay no
 * necesita ser un singleton.
 *
 * QUE GARANTIA DA
 * ───────────────
 * **Al menos una vez.** Si Redis acepta el `XADD` pero la transacción
 * no llega a confirmarse, el evento se volverá a publicar en la
 * siguiente vuelta. Eliminar ese caso exigiría una transacción
 * distribuida entre PostgreSQL y Redis; es mucho más barato que el
 * consumidor reconozca los repetidos por `eventId`, que es lo que
 * hace el Shift Service.
 *
 * La alternativa —"como mucho una vez"— sería perder eventos, y aquí
 * un evento perdido son horas trabajadas que no se le computan a
 * alguien. Entre repetir y perder, se repite.
 */

interface PendingRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  trace_context: string | null;
}

const tracer = trace.getTracer('outbox-relay');

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);

  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly retentionHours: number;
  private readonly maxAttempts: number;

  private timer?: NodeJS.Timeout;
  /** Evita que dos vueltas se solapen si una tarda más que el intervalo. */
  private running = false;
  private ticksSincePurge = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: OptionalRedis,
    config: ConfigService,
  ) {
    this.intervalMs = Number(config.get('OUTBOX_POLL_INTERVAL_MS', 1_000));
    this.batchSize = Number(config.get('OUTBOX_BATCH_SIZE', 100));
    this.retentionHours = Number(config.get('OUTBOX_RETENTION_HOURS', 168));
    this.maxAttempts = Number(config.get('OUTBOX_MAX_ATTEMPTS', 10));
  }

  onModuleInit(): void {
    if (!this.redis) {
      // No es un error: el servicio funciona sin bus. Los eventos se
      // acumulan en la tabla y saldrán en cuanto haya Redis, porque la
      // outbox es justamente lo que hace que esperar sea inofensivo.
      this.logger.warn(
        'Sin Redis: los eventos se acumularán en la outbox sin publicarse',
      );
      return;
    }

    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `Relay activo: ${ACCESS_EVENTS_STREAM} cada ${this.intervalMs} ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Una vuelta del relay. Es público para poder forzarla en los tests
   * y desde el arranque, sin depender del temporizador.
   */
  async tick(): Promise<number> {
    if (this.running || !this.redis) return 0;
    this.running = true;

    try {
      // EL SONDEO NO SE TRAZA.
      //
      // Esta vuelta ocurre cada segundo, tenga o no trabajo, y su
      // consulta a PostgreSQL generaria un span raiz cada vez: unas
      // ochenta y seis mil trazas al dia que no cuentan nada. Enterrar
      // las trazas que importan bajo el ruido de un temporizador es
      // una forma segura de que nadie vuelva a mirar Tempo.
      //
      // Se suprime aqui y se abre un span de verdad solo cuando hay
      // filas que publicar, dentro de `publishBatch`.
      const published = await context.with(
        suppressTracing(context.active()),
        () => this.publishBatch(),
      );

      // La purga no va en cada vuelta: es un DELETE sobre el histórico
      // y no hay ninguna prisa por hacerlo cada segundo.
      if (++this.ticksSincePurge >= 3_600) {
        this.ticksSincePurge = 0;
        await this.purge();
      }

      return published;
    } catch (error) {
      this.logger.error(
        `El relay no pudo completar la vuelta: ${(error as Error).message}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async publishBatch(): Promise<number> {
    const redis = this.redis;
    if (!redis) return 0;

    return this.prisma.$transaction(async (tx) => {
      // `SKIP LOCKED` es lo que permite varias réplicas: cada una toma
      // un lote distinto en vez de pelearse por el mismo.
      const pending = await tx.$queryRaw<PendingRow[]>`
        SELECT id, type, payload, attempts, trace_context
        FROM access_svc.outbox_events
        WHERE published_at IS NULL
          AND attempts < ${this.maxAttempts}
        ORDER BY created_at
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      if (pending.length === 0) return 0;

      const publishedIds: string[] = [];

      for (const row of pending) {
        try {
          // El evento viaja como un único campo JSON. Los streams de
          // Redis admiten pares campo-valor, pero desplegar el objeto
          // en campos sueltos ataría el formato del bus a la forma
          // exacta del evento, y añadir un campo obligaría a tocar el
          // consumidor. Con JSON, el contrato vive en un solo sitio:
          // access-events.ts.
          await this.publicarConTraza(redis, row);
          publishedIds.push(row.id);
        } catch (error) {
          // Un fallo se anota en la propia fila en vez de abortar el
          // lote: así un evento con un problema propio no bloquea la
          // cola detrás de él para siempre.
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: (error as Error).message.slice(0, 500),
            },
          });
          this.logger.warn(
            `Evento ${row.id} no publicado (intento ${row.attempts + 1}): ` +
              (error as Error).message,
          );
        }
      }

      if (publishedIds.length > 0) {
        await tx.outboxEvent.updateMany({
          where: { id: { in: publishedIds } },
          data: { publishedAt: new Date() },
        });
        this.logger.debug(`Publicados ${publishedIds.length} eventos`);
      }

      return publishedIds.length;
    });
  }

  /**
   * Publica una fila en el bus, continuando la traza que la origino.
   *
   * COMO SE COSE LA TRAZA A TRAVES DEL BUS
   * ──────────────────────────────────────
   * La fila guarda el `traceparent` de la peticion que concedio el
   * acceso. Aqui se recupera ese contexto, se abre un span de
   * publicacion colgando de el, y se inyecta el contexto de ESE span
   * en el propio mensaje de Redis. El consumidor lo extrae al otro
   * lado. El resultado es una sola traza que va del frame hasta la
   * transicion de turno.
   *
   * QUE SE ESTA ACEPTANDO A CAMBIO
   * ──────────────────────────────
   * La convencion de OpenTelemetry para mensajeria recomienda un
   * ENLACE en lugar de padre-hijo cuando hay lotes o abanico, porque
   * un consumidor puede procesar mensajes de muchas trazas a la vez.
   * Aqui la relacion es uno a uno y una traza conectada vale mucho
   * mas: ensena de un vistazo que el camino asincrono existe de
   * verdad. La contrapartida es que la traza dura mas que la peticion
   * HTTP que la abrio, y el hueco que se ve en medio NO es latencia:
   * es el intervalo de sondeo del relay.
   *
   * Si la fila no trae contexto —telemetria apagada cuando se
   * escribio, o una fila anterior a esta version— se publica igual y
   * sin span. Un paso no puede quedarse sin llegar al Shift Service
   * por un motivo de observabilidad.
   */
  private async publicarConTraza(
    redis: NonNullable<OptionalRedis>,
    row: PendingRow,
  ): Promise<void> {
    const publicar = async (): Promise<void> => {
      const portador: Record<string, string> = {};
      propagation.inject(context.active(), portador);

      // El contexto va en un campo SEPARADO del payload a proposito:
      // es metadato del transporte, no parte del contrato del evento,
      // y meterlo dentro del JSON obligaria al validador del consumidor
      // a conocerlo.
      //
      // Y solo se anade si tiene valor. Un campo vacio en el bus no es
      // inofensivo: el consumidor tendria que distinguir "no viene" de
      // "viene vacio", y ocupa sitio en cada mensaje de un stream
      // persistido en disco para decir nada.
      const campos: string[] = ['type', row.type, 'data', JSON.stringify(row.payload)];
      if (portador.traceparent) {
        campos.push('traceparent', portador.traceparent);
      }

      await redis.xadd(ACCESS_EVENTS_STREAM, '*', ...campos);
    };

    if (!row.trace_context) {
      await publicar();
      return;
    }

    // Se extrae desde ROOT_CONTEXT y NO desde el contexto activo, y
    // esto no es un detalle de estilo. El sondeo de `tick` corre con
    // el trazado suprimido para no generar una traza por segundo, y
    // esa supresion se HEREDA: derivando de aqui el contexto activo,
    // el span de publicacion nacia sin registrar y el tramo asincrono
    // no aparecia en ninguna traza. Partiendo de la raiz, el unico
    // padre de este span es el que viene guardado en la fila, que es
    // justo lo que se quiere.
    const padre = propagation.extract(ROOT_CONTEXT, {
      traceparent: row.trace_context,
    });

    await tracer.startActiveSpan(
      `${ACCESS_EVENTS_STREAM} publish`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'redis',
          'messaging.operation.name': 'publish',
          'messaging.destination.name': ACCESS_EVENTS_STREAM,
          'messaging.message.id': row.id,
          'event.type': row.type,
          // Cuantas vueltas tardo en salir. Un numero alto aqui es una
          // averia del bus que de otro modo solo se ve mirando la
          // tabla a mano.
          'outbox.attempts': row.attempts,
        },
      },
      padre,
      async (span) => {
        try {
          await publicar();
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Borra los eventos ya publicados y viejos.
   *
   * Los NO publicados no se tocan por antiguos que sean: si algo lleva
   * una semana sin salir, es una avería que hay que ver, no basura que
   * limpiar en silencio.
   */
  private async purge(): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionHours * 3_600_000);
    const { count } = await this.prisma.outboxEvent.deleteMany({
      where: { publishedAt: { not: null, lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Purgados ${count} eventos publicados hace más de ${this.retentionHours} h`);
    }
  }

  /** Eventos pendientes de publicar. Lo expone `/health`. */
  async backlog(): Promise<{ pending: number; stuck: number }> {
    const [pending, stuck] = await this.prisma.$transaction([
      this.prisma.outboxEvent.count({ where: { publishedAt: null } }),
      this.prisma.outboxEvent.count({
        where: { publishedAt: null, attempts: { gte: this.maxAttempts } },
      }),
    ]);
    return { pending, stuck };
  }
}
