/**
 * Motor de anti-passback.
 *
 * Responde a una sola pregunta: *este paso, ¿es coherente con dónde
 * dice el sistema que está esta persona?* Es una función pura —sin
 * base de datos, sin reloj propio, sin efectos— por el mismo motivo
 * que el motor de política: gobierna una puerta y tiene que poder
 * probarse exhaustivamente.
 *
 * QUE PROBLEMA RESUELVE
 * ─────────────────────
 * El clásico: alguien entra con su cara y pasa su credencial —o su
 * fotografía— a otra persona para que entre detrás. Si el sistema sabe
 * que ya estás dentro, la segunda entrada con tu identidad es
 * imposible por definición, y eso se detecta sin necesidad de
 * reconocer al segundo.
 *
 * También resuelve un problema mucho más prosaico y mucho más
 * frecuente: la cámara envía cinco frames por segundo y nada obliga al
 * cliente a dejar de pedir acceso después de obtenerlo. Sin ventana de
 * gracia, quedarse plantado delante del lector generaría un paso nuevo
 * cada pocas décimas de segundo, y en un torniquete bidireccional el
 * sistema haría entrar y salir a la misma persona en bucle.
 */

export type AntipassbackMode = 'HARD' | 'SOFT' | 'OFF';
export type PointDirection = 'IN' | 'OUT' | 'BOTH';
export type Passage = 'IN' | 'OUT';

/** Lo que el sistema cree saber del paradero de la persona. */
export interface PresenceSnapshot {
  inside: boolean;
  /** Momento del último paso registrado. */
  lastPassageAt: Date;
  /** Puerta del último paso registrado. */
  lastAccessPointId: string | null;
  /** Sentido del último paso registrado. */
  lastDirection: Passage;
}

export interface AntipassbackInput {
  /** Sentido configurado en el punto de acceso. */
  pointDirection: PointDirection;
  accessPointId: string;
  mode: AntipassbackMode;
  /** Presencia en ESTA zona; `null` si la persona nunca ha pasado. */
  presence: PresenceSnapshot | null;
  now: Date;
  /**
   * Cuánto tiempo se considera que dos lecturas en la misma puerta son
   * el mismo paso.
   */
  graceMs: number;
}

export type AntipassbackResult =
  /** Paso normal: se concede y se registra. */
  | { outcome: 'ALLOW'; direction: Passage }
  /**
   * Segunda lectura del mismo rostro en la misma puerta dentro de la
   * ventana de gracia. Se concede —la persona tiene derecho a pasar—
   * pero NO se registra como paso: no lo es.
   */
  | { outcome: 'ALLOW_REPEAT'; direction: Passage }
  /**
   * Incoherencia en una zona con modo blando: se concede, se corrige
   * la presencia y queda anotada la anomalía.
   */
  | { outcome: 'ALLOW_SOFT'; direction: Passage }
  /** Incoherencia en una zona con modo estricto. */
  | { outcome: 'DENY'; direction: Passage };

/**
 * Deduce si la persona entra o sale.
 *
 * En un punto de un solo sentido, la respuesta la da la configuración.
 * En uno bidireccional —un torniquete, o una tablet en un vano sin
 * puerta— la da la presencia: si estás fuera, entras; si estás dentro,
 * sales. Es lo que el modelo de datos ya daba por supuesto desde que
 * se añadió `PassageDirection.BOTH`.
 */
export function resolveDirection(
  pointDirection: PointDirection,
  presence: PresenceSnapshot | null,
): Passage {
  if (pointDirection !== 'BOTH') return pointDirection;
  return presence?.inside ? 'OUT' : 'IN';
}

export function evaluateAntipassback(
  input: AntipassbackInput,
): AntipassbackResult {
  const direction = resolveDirection(input.pointDirection, input.presence);

  // 1. ¿Es esto una lectura repetida del mismo paso?
  //
  //    Se comprueba ANTES que el modo y antes que la coherencia. Dentro
  //    de la ventana de gracia, y en la misma puerta, no hay forma de
  //    distinguir un paso nuevo de la misma persona que sigue delante
  //    del lector; y de las dos interpretaciones posibles, la que no
  //    inventa un paso es siempre la correcta.
  //
  //    Nótese que la comprobación es por puerta: pasar por la puerta
  //    del laboratorio dos segundos después de la entrada principal sí
  //    es un paso distinto, y debe registrarse como tal.
  if (
    input.presence &&
    input.presence.lastAccessPointId === input.accessPointId &&
    input.now.getTime() - input.presence.lastPassageAt.getTime() <=
      input.graceMs
  ) {
    // Se devuelve el sentido del paso ya registrado, no el recién
    // deducido: en un punto bidireccional, `resolveDirection` habría
    // dicho lo contrario justamente porque el primer paso ya cambió el
    // estado. Esta lectura no es un paso nuevo, es la misma de antes.
    return {
      outcome: 'ALLOW_REPEAT',
      direction: input.presence.lastDirection,
    };
  }

  if (input.mode === 'OFF') {
    return { outcome: 'ALLOW', direction };
  }

  // 2. ¿Es el paso coherente con lo que sabemos?
  //
  //    Un punto bidireccional NUNCA puede ser incoherente, porque su
  //    dirección se deduce del propio estado. La incoherencia solo
  //    existe en puertas de un solo sentido, que es donde el
  //    anti-passback tiene sentido.
  const entersWhileInside = direction === 'IN' && input.presence?.inside === true;
  const leavesWhileOutside =
    direction === 'OUT' && input.presence?.inside !== true;

  if (!entersWhileInside && !leavesWhileOutside) {
    return { outcome: 'ALLOW', direction };
  }

  return input.mode === 'HARD'
    ? { outcome: 'DENY', direction }
    : { outcome: 'ALLOW_SOFT', direction };
}
