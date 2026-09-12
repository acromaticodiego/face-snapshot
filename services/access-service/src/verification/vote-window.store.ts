/**
 * Almacén de las ventanas de votación multi-frame.
 *
 * POR QUE UNA INTERFAZ CON DOS IMPLEMENTACIONES
 * ─────────────────────────────────────────────
 * Es el mismo patrón que `FaceDetector` en el Vision Service (ADR
 * 0002): la política —cuántos votos hacen falta y cómo se cuentan— es
 * una sola, y lo intercambiable es dónde se guarda el recuento.
 *
 * · En memoria: cero dependencias, pero la ventana muere con el
 *   proceso y no se comparte entre réplicas.
 * · En Redis: varias réplicas del Access Service ven la misma ventana,
 *   que es la limitación #3 que el README arrastra desde el principio.
 *
 * La votación en sí NO cambia según el almacén. Si cambiara, un
 * despliegue con Redis concedería accesos que otro sin Redis denegaría,
 * y eso convertiría la infraestructura en política de seguridad.
 */

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

export interface VoteWindowStore {
  /** Identificador de una ventana nueva. */
  createKey(): string;

  /**
   * Registra el resultado de un frame y devuelve el estado de la
   * votación.
   *
   * Un frame sin coincidencia (`personId` null) NO se descarta: se
   * apunta igualmente, de modo que alternar entre una persona
   * registrada y una desconocida impida acumular votos. Solo una racha
   * consistente concede el acceso.
   */
  record(
    sessionKey: string | undefined,
    personId: string | null,
    similarity: number,
  ): Promise<VoteResult>;
}

/** Token de inyección: el almacén concreto lo decide `app.module`. */
export const VOTE_WINDOW_STORE = Symbol('VOTE_WINDOW_STORE');

/** Parámetros de la votación, idénticos en las dos implementaciones. */
export interface VotePolicy {
  required: number;
  windowSize: number;
  ttlMs: number;
}

export function readVotePolicy(get: (key: string, fallback: string) => string): VotePolicy {
  return {
    required: Number(get('RECOGNITION_VOTES_REQUIRED', '3')),
    windowSize: Number(get('RECOGNITION_WINDOW_SIZE', '5')),
    ttlMs: Number(get('RECOGNITION_WINDOW_TTL_MS', '10000')),
  };
}
