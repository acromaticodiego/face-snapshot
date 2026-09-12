import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

import { InMemoryVoteWindowStore, normalizeSessionKey } from './in-memory-vote-window.store';
import {
  type VotePolicy,
  type VoteResult,
  type VoteWindowStore,
} from './vote-window.store';

/**
 * Ventanas de votación compartidas en Redis.
 *
 * POR QUE UN SCRIPT LUA Y NO VARIOS COMANDOS
 * ──────────────────────────────────────────
 * Registrar un voto es leer-modificar-escribir: añadir el frame,
 * recortar la ventana, contar y —si se alcanzan los votos— consumirla.
 * Con comandos sueltos, dos frames simultáneos de la misma sesión
 * podrían contar ambos el voto decisivo y conceder DOS accesos con dos
 * sesiones distintas. Un script Lua se ejecuta de forma atómica en el
 * servidor, así que el borrado de la ventana ganadora y el recuento
 * ocurren sin que nadie se cuele en medio. De paso, es un único viaje
 * de red por frame en lugar de cinco.
 *
 * LA CADUCIDAD LA LLEVA REDIS
 * ───────────────────────────
 * No hace falta barrendero: `PEXPIRE` en cada escritura hace que una
 * ventana abandonada desaparezca sola. Es la implementación con MENOS
 * piezas móviles de las dos.
 */

const RECORD_VOTE_SCRIPT = `
local key         = KEYS[1]
local personId    = ARGV[1]
local similarity  = ARGV[2]
local windowSize  = tonumber(ARGV[3])
local required    = tonumber(ARGV[4])
local ttlMs       = tonumber(ARGV[5])

redis.call('RPUSH', key, personId .. '|' .. similarity)
-- Ventana deslizante: solo los ultimos M frames.
redis.call('LTRIM', key, -windowSize, -1)
redis.call('PEXPIRE', key, ttlMs)

local entries = redis.call('LRANGE', key, 0, -1)
local count = 0
local sum = 0.0

for _, entry in ipairs(entries) do
  local separator = string.find(entry, '|', 1, true)
  local entryPerson = string.sub(entry, 1, separator - 1)
  if personId ~= '' and entryPerson == personId then
    count = count + 1
    sum = sum + tonumber(string.sub(entry, separator + 1))
  end
end

local decided = 0
if personId ~= '' and count >= required then
  decided = 1
  -- Consumida la ventana: el siguiente intento vuelve a votar de cero.
  redis.call('DEL', key)
end

local average = similarity
if count > 0 then
  average = tostring(sum / count)
end

-- La media viaja como cadena: Lua entrega los numeros a Redis como
-- enteros y truncaria los decimales, que es justo lo que se audita.
return { count, decided, average }
`;

/** El cliente con el script ya registrado. */
interface RedisWithVoteScript extends Redis {
  recordVote(
    key: string,
    personId: string,
    similarity: string,
    windowSize: string,
    required: string,
    ttlMs: string,
  ): Promise<[number, number, string]>;
}

@Injectable()
export class RedisVoteWindowStore implements VoteWindowStore {
  private readonly logger = new Logger(RedisVoteWindowStore.name);
  private readonly client: RedisWithVoteScript;
  /** Momento del último aviso de degradación, para no inundar los logs. */
  private lastDegradedWarningAt = 0;

  constructor(
    client: Redis,
    private readonly policy: VotePolicy,
    /**
     * Almacén al que se cae si Redis no responde.
     *
     * Degradar en vez de fallar es deliberado: sin Redis, cada réplica
     * cuenta sus propios votos y entrar cuesta MAS, nunca menos. Es una
     * pérdida de eficiencia, no de seguridad. Devolver un error, en
     * cambio, dejaría a todo el mundo en la puerta porque un servicio
     * auxiliar se cayó.
     */
    private readonly fallback: InMemoryVoteWindowStore,
  ) {
    this.client = client as RedisWithVoteScript;
    // `defineCommand` cachea el script y usa EVALSHA: el cuerpo Lua
    // viaja una sola vez, no en cada frame.
    this.client.defineCommand('recordVote', {
      numberOfKeys: 1,
      lua: RECORD_VOTE_SCRIPT,
    });
  }

  createKey(): string {
    return randomUUID();
  }

  async record(
    sessionKey: string | undefined,
    personId: string | null,
    similarity: number,
  ): Promise<VoteResult> {
    const key = normalizeSessionKey(sessionKey);

    try {
      const [current, decided, average] = await this.client.recordVote(
        `votes:${key}`,
        personId ?? '',
        String(similarity),
        String(this.policy.windowSize),
        String(this.policy.required),
        String(this.policy.ttlMs),
      );

      return {
        sessionKey: key,
        current,
        required: this.policy.required,
        decidedPersonId: decided === 1 ? personId : null,
        averageSimilarity: Number(average),
      };
    } catch (error) {
      this.warnDegraded(error as Error);
      return this.fallback.record(key, personId, similarity);
    }
  }

  private warnDegraded(error: Error): void {
    const now = Date.now();
    if (now - this.lastDegradedWarningAt < 30_000) return;
    this.lastDegradedWarningAt = now;
    this.logger.warn(
      `Votación degradada a memoria: Redis no responde (${error.message})`,
    );
  }
}
