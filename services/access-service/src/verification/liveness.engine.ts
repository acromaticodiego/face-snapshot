/**
 * Decide si la evidencia de vida de un frame es aceptable.
 *
 * POR QUE LA POLITICA VIVE AQUI Y NO EN EL VISION SERVICE
 * ───────────────────────────────────────────────────────
 * El Vision Service mide y no juzga: devuelve números sobre la textura
 * del rostro. Un umbral de seguridad es política, y la política vive en
 * el único servicio que decide si una puerta se abre. Es el mismo
 * reparto que con el umbral de similitud (ADR 0003) y con el
 * anti-passback.
 *
 * LO QUE ESTO ES, DICHO SIN ADORNOS
 * ─────────────────────────────────
 * Un DISUASORIO, no un detector de ataques de presentación validado.
 * Nadie ha medido su tasa de falsa aceptación ni de falso rechazo
 * contra ataques reales, porque para eso hace falta un conjunto de
 * fotos impresas, pantallas y máscaras que este proyecto no tiene.
 *
 * Esa es exactamente la razón de que el modo por defecto sea `SOFT`:
 * anota la sospecha y deja pasar. Denegar el acceso a una persona real
 * apoyándose en una señal sin calibrar es peor que el problema que
 * intenta resolver — alguien se queda en la calle por un número que
 * nadie ha validado.
 *
 * LOS TRES MODOS SON LOS DEL ANTI-PASSBACK, A PROPOSITO
 * ─────────────────────────────────────────────────────
 * `OFF` / `SOFT` / `HARD` ya existen en este servicio para las zonas
 * con anti-passback, con el mismo significado: no mirar, mirar y
 * anotar, o mirar y cerrar. Reutilizar el vocabulario evita que quien
 * opera el sistema tenga que aprender dos escalas distintas para la
 * misma idea.
 */

export type LivenessMode = 'OFF' | 'SOFT' | 'HARD';

/** Lo que el Vision Service midió en un frame. */
export interface LivenessEvidence {
  detailRatio: number;
  patternPeak: number;
}

export interface LivenessPolicy {
  mode: LivenessMode;
  /**
   * Detalle fino mínimo. Por debajo, la imagen tiene menos textura de
   * la esperable en una captura directa: es lo que le pasa a una foto
   * de una foto, que atraviesa dos veces un proceso de captura.
   */
  minDetailRatio: number;
  /**
   * Pico periódico máximo. Por encima, hay un patrón repetitivo en la
   * imagen: la rejilla de una pantalla, o los bloques de una
   * recompresión.
   */
  maxPatternPeak: number;
}

export type LivenessVerdict =
  | { suspicious: false; reason: null }
  | { suspicious: true; reason: 'LOW_DETAIL' | 'PERIODIC_PATTERN' };

/**
 * Juzga un frame.
 *
 * SIN EVIDENCIA NO HAY SOSPECHA, Y ES DELIBERADO
 * ──────────────────────────────────────────────
 * Si el Vision Service no envía medidas —una versión anterior a esta
 * fase, o un fallo midiendo— el frame se considera limpio. La
 * alternativa, tratar la ausencia como sospecha, convertiría un
 * despliegue escalonado en una puerta cerrada para todo el mundo: el
 * Access Service se actualiza antes o después que el Vision Service, y
 * durante ese rato nadie entraría.
 *
 * Es la misma dirección de fallo que el resto del sistema elige cuando
 * la duda no es sobre la identidad: un componente de apoyo que falla no
 * puede dejar a nadie en la calle.
 */
export function judgeFrame(
  evidence: LivenessEvidence | undefined,
  policy: LivenessPolicy,
): LivenessVerdict {
  if (policy.mode === 'OFF' || !evidence) return { suspicious: false, reason: null };

  // El orden importa poco para el veredicto, pero sí para el motivo que
  // se registra: el patrón periódico es la señal más específica —una
  // pantalla— y conviene que gane cuando se dan las dos.
  if (evidence.patternPeak > policy.maxPatternPeak) {
    return { suspicious: true, reason: 'PERIODIC_PATTERN' };
  }
  if (evidence.detailRatio < policy.minDetailRatio) {
    return { suspicious: true, reason: 'LOW_DETAIL' };
  }
  return { suspicious: false, reason: null };
}
