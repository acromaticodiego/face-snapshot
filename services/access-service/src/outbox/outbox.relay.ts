import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
}

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
      const published = await this.publishBatch();

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
        SELECT id, type, payload, attempts
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
          await redis.xadd(
            ACCESS_EVENTS_STREAM,
            '*',
            'type',
            row.type,
            'data',
            JSON.stringify(row.payload),
          );
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
