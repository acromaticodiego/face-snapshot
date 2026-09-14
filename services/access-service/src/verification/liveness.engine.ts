/**
 * Decide si la evidencia de vida de un frame es aceptable.
 *
 * POR QUE LA POLITICA VIVE AQUI Y NO EN EL VISION SERVICE
 * ───────────────────────────────────────────────────────
 * El Vision Service mide y no juzga: devuelve la probabilidad de que el
 * rostro sea una persona delante de la cámara. Un umbral de seguridad
 * es política, y la política vive en el único servicio que decide si
 * una puerta se abre. Es el mismo reparto que con el umbral de
 * similitud (ADR 0003) y con el anti-passback.
 *
 * QUE HAY DETRAS DEL NUMERO, Y QUE SE SABE DE EL
 * ──────────────────────────────────────────────
 * `spoofScore` lo produce MiniFASNet, y a diferencia de las dos señales
 * espectrales que había antes, esta SÍ está medida contra un ataque
 * real: 40 caras y 38 fotos de esas caras en la pantalla de un móvil,
 * con la webcam del despliegue, en la variante de 640 px que es la que
 * el terminal envía de verdad.
 *
 *     cara real   0.9851 ± 0.0399   peor caso 0.7769
 *     pantalla    0.1187 ± 0.1517   mejor caso 0.5388
 *
 * Entre 0.5388 y 0.7769 no cae nada, y `minSpoofScore` va ahí en medio.
 * Los detalles, y lo que sigue sin estar probado, en el ADR 0014.
 *
 * LO QUE SIGUE SIN SER, DICHO SIN ADORNOS
 * ───────────────────────────────────────
 * Un detector de ataques de presentación validado. El conjunto con el
 * que se midió es de UNA persona y UN móvil: no hay foto impresa, ni
 * vídeo en pantalla, ni máscara, ni una segunda cara. La ISO/IEC
 * 30107-3 pide bastante más que esto para decir «APCER» en serio.
 *
 * Por eso el modo por defecto sigue siendo `SOFT`, aunque los números
 * hayan dejado de ser malos: lo que falta no es precisión, es cobertura
 * de ataques que nadie ha probado todavía.
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

/**
 * Lo que el Vision Service midió en un frame.
 *
 * `detailRatio` y `patternPeak` siguen llegando y NADIE LOS MIRA. Se
 * midieron contra el mismo conjunto de ataque y no separan: el mejor
 * corte posible del pico periódico, elegido sobre la sesión 1, daba 0 %
 * de error ahí y APCER 25 % con BPCER 20 % al aplicarlo a las sesiones
 * siguientes. Una de cada cinco personas en la calle. Quedan declarados
 * aquí para que quien lea el tipo sepa que existen y por qué no se
 * usan, no como una opción a la que volver.
 */
export interface LivenessEvidence {
  /**
   * Probabilidad de que el rostro sea una persona real, en [0, 1].
   *
   * Puede faltar, y su ausencia NO es sospecha: ver `judgeFrame`.
   */
  spoofScore?: number | null;
  detailRatio?: number;
  patternPeak?: number;
}

export interface LivenessPolicy {
  mode: LivenessMode;
  /**
   * Puntuación mínima para dar el frame por bueno.
   *
   * Está calibrada contra el modelo concreto que la produce. Si
   * `modelInfo.spoofDetector` cambia, la escala del número cambia con
   * él y este umbral deja de significar lo que significaba: hay que
   * volver a medir antes de tocarlo.
   */
  minSpoofScore: number;
}

export type LivenessVerdict =
  | { suspicious: false; reason: null }
  | { suspicious: true; reason: 'SPOOF_MODEL' };

/**
 * Juzga un frame.
 *
 * SIN EVIDENCIA NO HAY SOSPECHA, Y ES DELIBERADO
 * ──────────────────────────────────────────────
 * Si el Vision Service no envía la puntuación —una versión anterior a
 * esta fase, o un fallo midiendo— el frame se considera limpio. La
 * alternativa, tratar la ausencia como sospecha, convertiría un
 * despliegue escalonado en una puerta cerrada para todo el mundo: el
 * Access Service se actualiza antes o después que el Vision Service, y
 * durante ese rato nadie entraría.
 *
 * Por eso el Vision Service envía la puntuación AUSENTE cuando falla al
 * medirla, y nunca 0.0: un cero significa «ataque segurísimo» y en
 * `HARD` dejaría a una persona real en la calle por un error de código.
 * Las dos mitades de esa decisión tienen que coincidir, y esta es la
 * otra mitad.
 *
 * Es la misma dirección de fallo que el resto del sistema elige cuando
 * la duda no es sobre la identidad: un componente de apoyo que falla no
 * puede dejar a nadie fuera.
 */
export function judgeFrame(
  evidence: LivenessEvidence | undefined,
  policy: LivenessPolicy,
): LivenessVerdict {
  if (policy.mode === 'OFF' || !evidence) return { suspicious: false, reason: null };

  const puntuacion = evidence.spoofScore;
  // `== null` cubre a la vez `undefined` (el campo no vino) y `null`
  // (vino explícitamente vacío porque no se pudo medir). Las dos cosas
  // significan lo mismo aquí: no hay evidencia.
  if (puntuacion == null || !Number.isFinite(puntuacion)) {
    return { suspicious: false, reason: null };
  }

  if (puntuacion < policy.minSpoofScore) {
    return { suspicious: true, reason: 'SPOOF_MODEL' };
  }

  return { suspicious: false, reason: null };
}
