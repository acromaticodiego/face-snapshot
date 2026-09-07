import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

/**
 * Votación multi-frame.
 *
 * POR QUE EXISTE ESTO
 * ───────────────────
 * Conceder el acceso con un único frame es el fallo más común de estos
 * sistemas. Un parpadeo, un reflejo o un encuadre afortunado pueden
 * producir una coincidencia puntual por encima del umbral. Exigir N
 * coincidencias de la MISMA persona dentro de una ventana de M frames
 * reduce drásticamente los falsos positivos, a cambio de un segundo de
 * espera.
 *
 * Es además el punto exacto donde se enchufará la detección de vida
 * (liveness) cuando se implemente: la ventana ya acumula frames
 * consecutivos, que es justo lo que necesita un verificador temporal.
 *
 * ESTADO EN MEMORIA
 * ─────────────────
 * Las ventanas viven en memoria del proceso. Es suficiente mientras haya
 * una sola instancia del servicio. Al escalar a varias réplicas habrá
 * que moverlas a Redis, o fijar afinidad de sesión. Queda anotado en
 * docs/adr/0005.
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

export interface VoteResult {
  sessionKey: string;
  /** Votos acumulados a favor de la persona candidata. */
  current: number;
  required: number;
  /** Persona que gana la votación, solo cuando se alcanzan los votos. */
  decidedPersonId: string | null;
  /** Similitud media de los votos ganadores. */
  averageSimilarity: number;
}

@Injectable()
export class VoteWindowService implements OnModuleDestroy {
  private readonly logger = new Logger(VoteWindowService.name);
  private readonly windows = new Map<string, Window>();

  private readonly required: number;
  private readonly windowSize: number;
  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(config: ConfigService) {
    this.required = Number(config.get('RECOGNITION_VOTES_REQUIRED', 3));
    this.windowSize = Number(config.get('RECOGNITION_WINDOW_SIZE', 5));
    this.ttlMs = Number(config.get('RECOGNITION_WINDOW_TTL_MS', 10_000));

    // Sin esta limpieza, cada visitante que abandona la pantalla dejaría
    // una ventana huérfana: una fuga de memoria lenta pero segura.
    this.sweeper = setInterval(() => this.sweep(), this.ttlMs);
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  createKey(): string {
    return randomUUID();
  }

  /**
   * Registra el resultado de un frame y devuelve el estado de la votación.
   *
   * Un frame sin coincidencia (personId null) NO se descarta: se apunta
   * igualmente, de modo que alternar entre una persona registrada y una
   * desconocida impida acumular votos. Solo una racha consistente
   * concede el acceso.
   */
  record(
    sessionKey: string | undefined,
    personId: string | null,
    similarity: number,
  ): VoteResult {
    const key = sessionKey && this.windows.has(sessionKey)
      ? sessionKey
      : sessionKey ?? this.createKey();

    const now = Date.now();
    let window = this.windows.get(key);

    // Una ventana caducada se descarta: si alguien vuelve tras un minuto,
    // su votación empieza de cero.
    if (window && now - window.lastSeenAt > this.ttlMs) {
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
    if (window.entries.length > this.windowSize) {
      window.entries.splice(0, window.entries.length - this.windowSize);
    }

    // Se cuentan los votos de la persona candidata dentro de la ventana.
    const votesFor = personId
      ? window.entries.filter((e) => e.personId === personId)
      : [];

    const decided = votesFor.length >= this.required ? personId : null;
    const averageSimilarity = votesFor.length
      ? votesFor.reduce((sum, e) => sum + e.similarity, 0) / votesFor.length
      : similarity;

    if (decided) {
      // Consumida la ventana, se elimina para que el siguiente intento
      // vuelva a exigir la votación completa.
      this.windows.delete(key);
      this.logger.log(
        `Votación superada para ${decided}: ${votesFor.length}/${this.required} frames`,
      );
    }

    return {
      sessionKey: key,
      current: votesFor.length,
      required: this.required,
      decidedPersonId: decided,
      averageSimilarity,
    };
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (now - window.lastSeenAt > this.ttlMs) {
        this.windows.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(`Limpiadas ${removed} ventanas de votación caducadas`);
    }
  }
}
