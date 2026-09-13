/**
 * Análisis del umbral de reconocimiento con datos de producción.
 *
 * POR QUE ESTO EXISTE
 * ───────────────────
 * El umbral 0.38 se eligió midiendo seis rostros de las imágenes de
 * prueba de InsightFace (ADR 0003), y desde entonces el README lo
 * arrastra como limitación conocida: *"debe calibrarse con rostros y
 * cámara reales"*. La auditoría lleva desde el primer día guardando
 * exactamente el dato que hace falta: la similitud de cada intento.
 *
 * LA TRAMPA QUE HAY QUE EVITAR AQUI
 * ─────────────────────────────────
 * La tentación es contar "falsos rechazos" y "falsas aceptaciones"
 * sobre estos datos. **Serían siempre cero, por construcción.** Un
 * intento se clasifica como reconocido o desconocido usando el propio
 * umbral que se quiere evaluar, así que las dos nubes salen partidas
 * exactamente por él: nunca habrá un desconocido por encima ni un
 * reconocido por debajo.
 *
 * En estadística eso es una muestra *censurada*, y da un gráfico
 * precioso que no significa nada. Medir tasas de error de verdad exige
 * datos etiquetados por una persona, que es lo que hace
 * `tests/test_recognition_quality.py` del Vision Service y no se puede
 * hacer con el registro de accesos.
 *
 * QUE SI SE PUEDE MEDIR, Y ES LO QUE IMPORTA
 * ──────────────────────────────────────────
 * El **margen**. Hasta dónde llegó el desconocido que más se acercó, y
 * cuánto le sobró al reconocido que menos margen tuvo. Si un extraño
 * roza el umbral, estás a un frame afortunado de dejarle pasar, y eso
 * el registro de accesos sí lo sabe.
 *
 * Función pura, para poder probar con distribuciones fabricadas los
 * casos que en producción tardarían meses en aparecer.
 */

/** Resumen de una de las dos nubes de similitudes. */
export interface CloudStats {
  samples: number;
  /** Similitud mínima observada. `null` si no hay muestras. */
  min: number | null;
  /** Similitud máxima observada. `null` si no hay muestras. */
  max: number | null;
}

export type ThresholdVerdict =
  /** Las dos nubes están lejos del umbral por ambos lados. */
  | 'HOLGADO'
  /** Alguna de las dos roza el umbral: un mal frame y hay incidente. */
  | 'AJUSTADO'
  /** Se pisan. Ningún umbral las separa; el problema es la captura. */
  | 'SOLAPADO'
  | 'SIN_DATOS';

export interface ThresholdAnalysis {
  threshold: number;
  verdict: ThresholdVerdict;

  /**
   * Hueco entre el desconocido más alto y el reconocido más bajo.
   *
   * Es la cifra a comparar con el 0.2552 que midió el ADR 0003 sobre
   * fotos de archivo. Si en producción sale mucho menor, el umbral está
   * calibrado con datos que no representan la realidad del vestíbulo.
   */
  separation: number | null;

  /**
   * Cuánto le faltó al desconocido que más se acercó.
   *
   * Es el margen de seguridad real. Pequeño significa que un reflejo
   * afortunado deja pasar a alguien.
   */
  marginBelow: number | null;

  /**
   * Cuánto le sobró al reconocido que peor lo tuvo.
   *
   * Pequeño significa gente legítima quedándose en la puerta en cuanto
   * empeore la luz.
   */
  marginAbove: number | null;

  recognized: CloudStats;
  unrecognized: CloudStats;

  /**
   * Advertencia de método, para que el panel la muestre y nadie saque
   * conclusiones de más.
   */
  caveat: string;
}

/** Margen por debajo del cual se considera que el umbral va justo. */
const TIGHT_MARGIN = 0.05;

const CAVEAT =
  'Las dos nubes están separadas por el propio umbral, así que no ' +
  'pueden medirse tasas de error a partir de aquí: lo que se mide es ' +
  'el margen que queda a cada lado.';

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function analyzeThreshold(
  recognized: CloudStats,
  unrecognized: CloudStats,
  threshold: number,
): ThresholdAnalysis {
  const top = unrecognized.max;
  const bottom = recognized.min;

  const separation = top !== null && bottom !== null ? bottom - top : null;
  const marginBelow = top !== null ? threshold - top : null;
  const marginAbove = bottom !== null ? bottom - threshold : null;

  return {
    threshold,
    verdict: verdictFor(separation, marginBelow, marginAbove),
    separation: separation === null ? null : round(separation),
    marginBelow: marginBelow === null ? null : round(marginBelow),
    marginAbove: marginAbove === null ? null : round(marginAbove),
    recognized,
    unrecognized,
    caveat: CAVEAT,
  };
}

function verdictFor(
  separation: number | null,
  marginBelow: number | null,
  marginAbove: number | null,
): ThresholdVerdict {
  // Hace falta ver las dos nubes para decir nada: con solo accesos
  // concedidos no hay de qué separarlos.
  if (separation === null) return 'SIN_DATOS';

  // Solapadas no debería poder ocurrir con datos de producción —el
  // umbral las parte—, pero sí al analizar un conjunto etiquetado a
  // mano, y entonces es el hallazgo más importante de todos.
  if (separation <= 0) return 'SOLAPADO';

  const tightest = Math.min(
    marginBelow ?? Number.POSITIVE_INFINITY,
    marginAbove ?? Number.POSITIVE_INFINITY,
  );

  return tightest < TIGHT_MARGIN ? 'AJUSTADO' : 'HOLGADO';
}
