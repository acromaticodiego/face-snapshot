import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  type VotePolicy,
  type VoteResult,
  type VoteWindowStore,
} from './vote-window.store';

/**
 * Ventanas de votación en la memoria del proceso.
 *
 * Es el comportamiento original del servicio y sigue siendo el que se
 * usa cuando no hay Redis configurado. Suficiente con una sola
 * instancia; con varias, cada réplica contaría por su cuenta y haría
 * falta acumular más frames de los previstos para entrar. Nótese la
 * dirección del fallo: sin estado compartido cuesta MAS entrar, nunca
 * menos. Por eso degradar a este almacén es seguro.
 */

interface VoteEntry {
  personId: string | null;
  similarity: number;
  at: number;
}

interface Window {
  key: string;
  entries: VoteEntry[];
  createdAt: number;
  lastSeenAt: number;
}

/** Una clave de ventana solo puede ser un UUID emitido por nosotros. */
const KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Filtra la clave que envía el cliente.
 *
 * El terminal reenvía la `sessionKey` que le dimos, pero nada impide a
 * un cliente inventarse una. Aceptar cualquier cadena permitiría llenar
 * el almacén de claves basura —en Redis, sin coste para el atacante— y
 * ensuciaría los logs. Una clave que no sea un UUID nuestro se
 * descarta y se empieza una ventana nueva; el peor efecto para un
 * cliente legítimo mal implementado es tener que votar de cero.
 */
export function normalizeSessionKey(sessionKey: string | undefined): string {
  return sessionKey && KEY_PATTERN.test(sessionKey) ? sessionKey : randomUUID();
}

@Injectable()
export class InMemoryVoteWindowStore
  implements VoteWindowStore, OnModuleDestroy
{
  private readonly logger = new Logger(InMemoryVoteWindowStore.name);
  private readonly windows = new Map<string, Window>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly policy: VotePolicy) {
    // Sin esta limpieza, cada visitante que abandona la pantalla dejaría
    // una ventana huérfana: una fuga de memoria lenta pero segura.
    this.sweeper = setInterval(() => this.sweep(), this.policy.ttlMs);
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  createKey(): string {
    return randomUUID();
  }

  record(
    sessionKey: string | undefined,
    personId: string | null,
    similarity: number,
  ): Promise<VoteResult> {
    const key = normalizeSessionKey(sessionKey);
    const now = Date.now();
    let window = this.windows.get(key);

    // Una ventana caducada se descarta: si alguien vuelve tras un
    // minuto, su votación empieza de cero.
    if (window && now - window.lastSeenAt > this.policy.ttlMs) {
      this.windows.delete(key);
      window = undefined;
    }

    if (!window) {
      window = { key, entries: [], createdAt: now, lastSeenAt: now };
      this.windows.set(key, window);
    }

    window.lastSeenAt = now;
    window.entries.push({ personId, similarity, at: now });

    // Solo se conservan los últimos M frames: la ventana es deslizante.
    if (window.entries.length > this.policy.windowSize) {
      window.entries.splice(0, window.entries.length - this.policy.windowSize);
    }

    const votesFor = personId
      ? window.entries.filter((entry) => entry.personId === personId)
      : [];

    const decided = votesFor.length >= this.policy.required ? personId : null;
    const averageSimilarity = votesFor.length
      ? votesFor.reduce((sum, entry) => sum + entry.similarity, 0) /
        votesFor.length
      : similarity;

    if (decided) {
      // Consumida la ventana, se elimina para que el siguiente intento
      // vuelva a exigir la votación completa.
      this.windows.delete(key);
    }

    return Promise.resolve({
      sessionKey: key,
      current: votesFor.length,
      required: this.policy.required,
      decidedPersonId: decided,
      averageSimilarity,
    });
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (now - window.lastSeenAt > this.policy.ttlMs) {
        this.windows.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(`Limpiadas ${removed} ventanas de votación caducadas`);
    }
  }
}
