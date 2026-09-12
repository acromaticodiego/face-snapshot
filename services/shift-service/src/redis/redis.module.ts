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
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: OptionalRedis,
  ) {}

  /**
   * Cierra la conexión al apagar el servicio.
   *
   * Sin esto, `nest start --watch` deja una conexión viva por cada
   * recarga y Redis acaba rechazando clientes nuevos.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;
    // `quit` espera a que Redis confirme; si ya está caído, no hay a
    // quién esperar y se corta sin más.
    await this.client.quit().catch(() => this.client?.disconnect());
  }
}
