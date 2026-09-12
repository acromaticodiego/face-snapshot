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
 * POR QUE APARECE REDIS AHORA
 * ───────────────────────────
 * El ADR 0005 decidió no tener broker y enumeró los disparadores para
 * reconsiderarlo. Dos se cumplen ya: la auditoría de presencia debe
 * salir del camino crítico, y las ventanas de votación tienen que
 * poder compartirse entre réplicas. Ver docs/adr/0007.
 *
 * REDIS ES OPCIONAL A PROPOSITO
 * ─────────────────────────────
 * Sin `REDIS_URL` el proveedor entrega `null` y el servicio arranca
 * igual: las ventanas de votación vuelven a memoria y el relay de
 * eventos se queda quieto. Redis acelera y desacopla, pero NO debe
 * ser capaz de dejar a nadie fuera de la puerta.
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
          // Sin cola de espera: si Redis no responde, el comando falla
          // en el acto y quien llama decide qué hacer. Encolar dejaría
          // la petición del terminal colgada hasta el timeout, que es
          // la peor respuesta posible para alguien parado ante la
          // puerta.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          // Reintento con techo: reconecta rápido tras un corte breve
          // sin castigar a Redis con miles de intentos si está caído.
          retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
        });

        client.on('error', (error: Error) => {
          // A nivel debug y no error: ioredis emite este evento en cada
          // reintento, y con Redis caído llenaría los logs de ruido
          // idéntico. Lo que sí importa —que una operación concreta se
          // degradó— lo registra quien la intentó.
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
