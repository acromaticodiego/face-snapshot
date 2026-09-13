import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Conexión a Redis, compartida por el servicio.
 *
 * Es de donde llegan los eventos de acceso: sin Redis, este servicio
 * no tiene forma de enterarse de que alguien ha pasado por una puerta.
 *
 * REDIS ES OPCIONAL AUN ASI
 * ─────────────────────────
 * Sin `REDIS_URL` el proveedor entrega `null` y el servicio arranca
 * igual, solo que la jornada no avanza. Se prefiere eso a negarse a
 * arrancar: las consultas de lo ya calculado siguen respondiendo, y
 * los eventos no se pierden porque esperan en la outbox del Access
 * Service hasta que haya bus.
 */

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Conexión SEPARADA, solo para la sonda de salud.
 *
 * POR QUE NO VALE LA CONEXION PRINCIPAL
 * ─────────────────────────────────────
 * El consumidor vive dentro de un `XREADGROUP ... BLOCK 5000`, que deja
 * la conexión esperando en el servidor. Redis atiende los comandos de
 * una conexión EN ORDEN, así que un `PING` enviado por ese mismo
 * socket se queda encolado detrás del bloqueo hasta que termine.
 *
 * El efecto era que `/health` decía «bus inalcanzable» con Redis
 * perfectamente sano. Medido: 5 de cada 8 sondas fallaban, que es justo
 * la proporción entre el plazo del ping (2 s) y el bloqueo del
 * consumidor (5 s).
 *
 * Una sonda que miente es peor que no tenerla: enseña a ignorar la
 * única señal que avisaría de un corte de verdad.
 */
export const REDIS_PROBE = Symbol('REDIS_PROBE');

/** El cliente puede no existir: siempre hay que comprobarlo antes de usarlo. */
export type OptionalRedis = Redis | null;

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): OptionalRedis => {
        const logger = new Logger('Redis');
        const url = config.get<string>('REDIS_URL');

        if (!url) {
          logger.warn(
            'REDIS_URL no está definida: votación en memoria y eventos sin publicar',
          );
          return null;
        }

        const client = new Redis(url, {
          // A diferencia del Access Service, aquí NO se desactiva la
          // cola de espera ni se limita el número de reintentos: este
          // consumidor vive de una lectura bloqueante y lo que se
          // quiere ante un corte es que reanude solo, no que falle
          // rápido. Nadie está esperando de pie a que responda.
          maxRetriesPerRequest: null,
          // Reintento con techo: reconecta rápido tras un corte breve
          // sin castigar a Redis con miles de intentos si está caído.
          retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
        });

        client.on('error', (error: Error) => {
          // A nivel debug y no error: ioredis emite este evento en cada
          // reintento, y con Redis caído llenaría los logs de ruido
          // idéntico. Lo que sí importa —que el consumo se interrumpió—
          // lo registra el propio consumidor.
          logger.debug(`Redis no disponible: ${error.message}`);
        });
        client.on('ready', () => logger.log(`Conectado a Redis (${url})`));

        return client;
      },
    },
    {
      provide: REDIS_PROBE,
      inject: [REDIS_CLIENT],
      useFactory: (client: OptionalRedis): OptionalRedis => {
        if (!client) return null;

        // `duplicate` copia las opciones del cliente principal, y hay
        // dos que para una sonda son exactamente las contrarias de lo
        // que conviene:
        //
        //   · `maxRetriesPerRequest: null` hace que un comando espere
        //     indefinidamente a que Redis vuelva. En el consumidor eso
        //     es lo que se quiere; en una sonda significa colgarse.
        //   · la cola de espera guarda el comando hasta reconectar, de
        //     modo que un `PING` con Redis caído no falla, se aplaza.
        //
        // Aquí se invierten las dos: la sonda tiene que responder
        // rápido y decir la verdad, aunque la verdad sea que no hay
        // bus.
        const probe = client.duplicate({
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 1_000,
        });

        // Sin este manejador, un fallo de conexión de la sonda emite un
        // `error` sin escuchar y tumba el proceso. Se traga a
        // propósito: lo que la sonda averigua se cuenta respondiendo a
        // `/health`, no lanzando.
        probe.on('error', () => undefined);

        return probe;
      },
    },
  ],
  exports: [REDIS_CLIENT, REDIS_PROBE],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: OptionalRedis,
    @Inject(REDIS_PROBE) private readonly probe: OptionalRedis,
  ) {}

  /**
   * Cierra la conexión al apagar el servicio.
   *
   * Sin esto, `nest start --watch` deja una conexión viva por cada
   * recarga y Redis acaba rechazando clientes nuevos.
   */
  async onApplicationShutdown(): Promise<void> {
    // Las dos conexiones, no solo la principal: la sonda es una
    // conexión de pleno derecho y dejarla abierta tiene el mismo
    // efecto que dejaba la otra.
    for (const conexion of [this.probe, this.client]) {
      if (!conexion) continue;
      // `quit` espera a que Redis confirme; si ya está caído, no hay a
      // quién esperar y se corta sin más.
      await conexion.quit().catch(() => conexion.disconnect());
    }
  }
}
