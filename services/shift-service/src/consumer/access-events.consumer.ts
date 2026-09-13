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
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

import { ShiftsService } from '../shifts/shifts.service';
import { REDIS_CLIENT, type OptionalRedis } from '../redis/redis.module';
import {
  parseAccessGrantedEvent,
  traceparentDelMensaje,
} from './access-event.parser';

/**
 * Consume los eventos de acceso desde Redis Streams.
 *
 * POR QUE UN GRUPO DE CONSUMIDORES Y NO UN XREAD A SECAS
 * ──────────────────────────────────────────────────────
 * Un `XREAD` normal solo lee lo que llega mientras estás escuchando:
 * lo publicado durante un reinicio se pierde. Un grupo de consumidores
 * mantiene su propia posición en el servidor y una lista de mensajes
 * entregados pero sin confirmar —la PEL—, así que al volver de una
 * caída se retoma exactamente donde se quedó.
 *
 * CUANDO SE CONFIRMA UN MENSAJE
 * ─────────────────────────────
 * `XACK` va **después** de haberlo escrito en PostgreSQL, nunca antes.
 * Confirmar primero convertiría cualquier fallo de la base de datos en
 * un evento perdido para siempre; confirmando después, un fallo deja
 * el mensaje en la PEL y otro intento lo recogerá. Con esto la entrega
 * es "al menos una vez" de extremo a extremo, y lo que la hace
 * inofensiva es que la escritura sea idempotente por `sourceEventId`.
 *
 * MENSAJES QUE SE QUEDAN COLGADOS
 * ───────────────────────────────
 * Si el proceso muere entre la entrega y el `XACK`, el mensaje queda
 * en la PEL a nombre de un consumidor que ya no existe. `XAUTOCLAIM`
 * lo reclama pasado un tiempo. Sin eso, un reinicio en el peor momento
 * dejaría un paso sin procesar indefinidamente.
 *
 * ORDEN Y ESCALADO — limitación asumida
 * ─────────────────────────────────────
 * Con un solo consumidor, los eventos llegan en el orden en que se
 * publicaron. Con varios, el grupo los reparte y dos pasos de la misma
 * persona podrían procesarse a destiempo. La máquina de estados
 * descarta lo que llega desordenado, así que el efecto sería perder
 * transiciones, no corromperlas; aun así, escalar este servicio
 * exigiría repartir por persona en varios streams. Está anotado en el
 * ADR 0007.
 */

const CONSUMER_GROUP = 'shift-service';

const tracer = trace.getTracer('access-events-consumer');

@Injectable()
export class AccessEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessEventsConsumer.name);

  private readonly stream: string;
  private readonly consumerName: string;
  private readonly blockMs: number;
  private readonly batchSize: number;
  private readonly claimAfterMs: number;

  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    private readonly shifts: ShiftsService,
    @Inject(REDIS_CLIENT) private readonly redis: OptionalRedis,
    config: ConfigService,
  ) {
    this.stream = config.get<string>('ACCESS_EVENTS_STREAM', 'access.events');
    // El nombre identifica a ESTA instancia dentro del grupo. Con el
    // hostname, en Docker cada réplica tiene el suyo sin configurarlo.
    this.consumerName =
      config.get<string>('CONSUMER_NAME') ?? `shift-${process.env.HOSTNAME ?? process.pid}`;
    this.blockMs = Number(config.get('CONSUMER_BLOCK_MS', 5_000));
    this.batchSize = Number(config.get('CONSUMER_BATCH_SIZE', 50));
    this.claimAfterMs = Number(config.get('CONSUMER_CLAIM_AFTER_MS', 60_000));
  }

  async onModuleInit(): Promise<void> {
    if (!this.redis) {
      this.logger.warn(
        'Sin REDIS_URL: no se consumirán eventos y la jornada no avanzará',
      );
      return;
    }

    await this.ensureGroup();
    this.loop = this.run();
    this.logger.log(
      `Consumiendo ${this.stream} como ${this.consumerName} (grupo ${CONSUMER_GROUP})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    // Se espera a que termine la vuelta en curso: cortar en seco
    // dejaría mensajes entregados y sin confirmar que otro tendría que
    // reclamar por tiempo, retrasando su procesado sin motivo.
    await this.loop?.catch(() => undefined);
  }

  private async ensureGroup(): Promise<void> {
    try {
      // `MKSTREAM` crea el stream si aún no existe: el consumidor puede
      // arrancar antes de que nadie haya pasado por una puerta.
      // El `0` inicial —y no `$`— es deliberado: al crear el grupo por
      // primera vez se leen también los eventos que ya estuvieran
      // publicados, en lugar de empezar a mirar desde ahora y perder
      // todo lo anterior.
      await this.redis!.xgroup(
        'CREATE',
        this.stream,
        CONSUMER_GROUP,
        '0',
        'MKSTREAM',
      );
      this.logger.log(`Grupo ${CONSUMER_GROUP} creado sobre ${this.stream}`);
    } catch (error) {
      // BUSYGROUP: ya existía, que es el caso normal en cada arranque.
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.claimStale();
        await this.readBatch();
      } catch (error) {
        const message = (error as Error).message;

        // NOGROUP: el stream o el grupo han dejado de existir. Pasa si
        // alguien vacía Redis o borra el stream a mano. Sin volver a
        // crear el grupo, este bucle giraría en falso para siempre y
        // solo un reinicio lo arreglaría: el consumidor tiene que
        // recuperarse solo.
        if (message.includes('NOGROUP')) {
          this.logger.warn('El grupo de consumidores desapareció; se recrea');
          await this.ensureGroup().catch(() => undefined);
          continue;
        }

        // Cualquier otro fallo es casi siempre Redis caído. Se espera
        // antes de reintentar para no convertir la caída en un bucle
        // cerrado que consuma una CPU entera.
        this.logger.warn(`Consumo interrumpido, reintentando: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, this.blockMs));
      }
    }
  }

  private async readBatch(): Promise<void> {
    // `>` significa "solo mensajes que nadie de este grupo ha recibido
    // todavía". `BLOCK` deja la conexión esperando en el servidor en
    // vez de preguntar en bucle.
    //
    // LA ESPERA NO SE TRAZA. Este bucle gira cada cinco segundos haya
    // o no mensajes, y cada vuelta generaría un span raíz de cinco
    // segundos: diecisiete mil trazas diarias que solo dicen "no había
    // nada". La traza de un evento se abre en `handle`, colgando de la
    // que lo originó, y no de esta espera.
    const response = await context.with(
      suppressTracing(context.active()),
      () =>
        this.redis!.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          this.consumerName,
          'COUNT',
          this.batchSize,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.stream,
          '>',
        ),
    );

    if (!response) return;

    for (const [, messages] of response as [string, [string, string[]][]][]) {
      await this.handle(messages);
    }
  }

  /**
   * Recupera mensajes entregados a un consumidor que no los confirmó.
   *
   * Es el seguro contra el peor momento posible para caerse: entre
   * recibir un paso y escribirlo.
   */
  private async claimStale(): Promise<void> {
    // Tampoco se traza: gira en cada vuelta y casi siempre vuelve
    // vacío. Lo que sí se traza es procesar lo que reclame.
    const [, messages] = (await context.with(
      suppressTracing(context.active()),
      () =>
        this.redis!.xautoclaim(
          this.stream,
          CONSUMER_GROUP,
          this.consumerName,
          this.claimAfterMs,
          '0',
          'COUNT',
          this.batchSize,
        ),
    )) as [string, [string, string[]][]];

    if (messages.length === 0) return;

    this.logger.warn(
      `Reclamados ${messages.length} eventos que quedaron sin confirmar`,
    );
    await this.handle(messages);
  }

  private async handle(messages: [string, string[]][]): Promise<void> {
    for (const [messageId, fields] of messages) {
      // Un mensaje reclamado puede haber sido borrado del stream por
      // MAXLEN o XDEL; llega con los campos vacíos y solo hay que
      // confirmarlo para sacarlo de la PEL.
      if (!fields || fields.length === 0) {
        await this.redis!.xack(this.stream, CONSUMER_GROUP, messageId);
        continue;
      }

      const event = parseAccessGrantedEvent(fields);

      if (!event) {
        // Un mensaje que no se entiende no se puede procesar nunca, así
        // que reintentarlo eternamente solo bloquearía la cola. Se
        // confirma y se deja constancia ruidosa: es un fallo de
        // contrato entre servicios y alguien tiene que verlo.
        this.logger.error(
          `Evento ilegible en ${messageId}; se descarta para no bloquear la cola`,
        );
        await this.redis!.xack(this.stream, CONSUMER_GROUP, messageId);
        continue;
      }

      // El span cuelga de la traza que concedió el acceso, no de este
      // bucle. Es lo que hace que una sola traza vaya del frame hasta
      // la transición de turno, cruzando el bus por el medio.
      const traceparent = traceparentDelMensaje(fields);
      // Desde ROOT_CONTEXT, no desde el activo: el único padre legítimo
      // de este span es el que viaja en el mensaje. Derivar del
      // contexto ambiente arrastraría lo que hubiera en el bucle de
      // consumo —incluida la supresión de trazado de la espera— y el
      // span nacería sin registrar.
      const padre = traceparent
        ? propagation.extract(ROOT_CONTEXT, { traceparent })
        : null;

      const procesar = async (span?: Span): Promise<void> => {
        try {
          await this.shifts.applyAccessEvent(event);
          // XACK solo después de escribir: ver la cabecera del archivo.
          await this.redis!.xack(this.stream, CONSUMER_GROUP, messageId);
        } catch (error) {
          // Sin XACK: el mensaje se queda en la PEL y `xautoclaim` lo
          // recuperará. Es lo correcto ante un fallo transitorio de la
          // base de datos.
          span?.recordException(error as Error);
          span?.setStatus({ code: SpanStatusCode.ERROR });
          this.logger.error(
            `No se pudo aplicar el evento ${event.eventId}: ${(error as Error).message}`,
          );
        } finally {
          span?.end();
        }
      };

      if (!padre) {
        // Evento publicado sin telemetría. Se procesa igual y sin span:
        // la jornada de alguien no depende de que haya trazas.
        await procesar();
        continue;
      }

      await tracer.startActiveSpan(
        `${this.stream} process`,
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            'messaging.system': 'redis',
            'messaging.operation.name': 'process',
            'messaging.destination.name': this.stream,
            'messaging.consumer.group.name': CONSUMER_GROUP,
            'messaging.message.id': event.eventId,
            'event.type': event.type,
            // El efecto sobre la jornada: es lo que convierte el span
            // en algo que se lee sin abrir la base de datos.
            'shift.direction': event.direction,
            'shift.zone_effect': event.zoneShiftEffect,
            'shift.still_inside_site': event.stillInsideSite,
          },
        },
        padre,
        procesar,
      );
    }
  }
}
