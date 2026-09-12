import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { REDIS_CLIENT, type OptionalRedis } from '../redis/redis.module';
import { InMemoryVoteWindowStore } from './in-memory-vote-window.store';
import { RedisVoteWindowStore } from './redis-vote-window.store';
import {
  readVotePolicy,
  VOTE_WINDOW_STORE,
  type VotePolicy,
  type VoteWindowStore,
} from './vote-window.store';

function policyFrom(config: ConfigService): VotePolicy {
  return readVotePolicy((key, fallback) => config.get<string>(key, fallback));
}

/**
 * El almacén en memoria se registra SIEMPRE, aunque haya Redis.
 *
 * Dos motivos: es el destino al que degrada el almacén de Redis cuando
 * este no responde, y al estar en el contenedor de Nest es este quien
 * detiene su temporizador de limpieza al apagar el servicio.
 */
export const inMemoryVoteWindowStoreProvider: Provider = {
  provide: InMemoryVoteWindowStore,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new InMemoryVoteWindowStore(policyFrom(config)),
};

/**
 * Elige dónde se guardan las ventanas de votación.
 *
 * Por defecto se sigue a la infraestructura disponible: con Redis
 * configurado, las ventanas se comparten entre réplicas; sin él, viven
 * en memoria. `VOTE_WINDOW_BACKEND=memory` fuerza el comportamiento
 * antiguo aunque haya Redis, que es lo que se quiere al depurar la
 * votación sin ruido de otras instancias.
 */
export const voteWindowStoreProvider: Provider = {
  provide: VOTE_WINDOW_STORE,
  inject: [ConfigService, REDIS_CLIENT, InMemoryVoteWindowStore],
  useFactory: (
    config: ConfigService,
    redis: OptionalRedis,
    memory: InMemoryVoteWindowStore,
  ): VoteWindowStore => {
    const logger = new Logger('VoteWindow');
    const policy = policyFrom(config);
    const shape = `${policy.required} de ${policy.windowSize} frames`;

    if (config.get<string>('VOTE_WINDOW_BACKEND') === 'memory' || !redis) {
      logger.log(`Votación en memoria (${shape})`);
      return memory;
    }

    logger.log(`Votación compartida en Redis (${shape})`);
    return new RedisVoteWindowStore(redis, policy, memory);
  },
};
