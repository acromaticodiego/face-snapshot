import { analyzeThreshold, type CloudStats } from './threshold.analysis';

/**
 * El valor de este análisis está en lo que se NIEGA a afirmar, así que
 * los casos límite pesan más que los normales: el despliegue recién
 * estrenado, la nube que solo tiene un lado, y el margen que se estrecha
 * sin que nadie se dé cuenta.
 */

function cloud(
  samples: number,
  min: number | null,
  max: number | null,
): CloudStats {
  return { samples, min, max };
}

/** Los valores reales medidos en este despliegue, para no inventarlos. */
const REAL_RECOGNIZED = cloud(138, 0.4155, 0.998);
const REAL_UNRECOGNIZED = cloud(101, -0.0818, 0.3514);

describe('analyzeThreshold · datos reales del despliegue', () => {
  const result = analyzeThreshold(REAL_RECOGNIZED, REAL_UNRECOGNIZED, 0.38);

  it('mide la separación real entre las dos nubes', () => {
    // El ADR 0003 midió 0.2552 sobre fotos de archivo. En producción es
    // cuatro veces menor, y ese contraste es justamente el motivo de
    // que exista este análisis.
    expect(result.separation).toBeCloseTo(0.0641, 4);
  });

  it('avisa de que el umbral va ajustado', () => {
    expect(result.verdict).toBe('AJUSTADO');
  });

  it('dice cuánto le faltó al desconocido que más se acercó', () => {
    expect(result.marginBelow).toBeCloseTo(0.0286, 4);
  });

  it('dice cuánto le sobró al reconocido que peor lo tuvo', () => {
    expect(result.marginAbove).toBeCloseTo(0.0355, 4);
  });
});

describe('analyzeThreshold · veredicto', () => {
  it('holgado cuando las dos nubes están lejos del umbral', () => {
    const result = analyzeThreshold(
      cloud(500, 0.62, 0.99),
      cloud(400, -0.1, 0.2),
      0.38,
    );

    expect(result.verdict).toBe('HOLGADO');
    expect(result.separation).toBeCloseTo(0.42, 4);
  });

  it('ajustado si SOLO se estrecha el lado de los desconocidos', () => {
    // Es el lado peligroso: un extraño rozando el umbral significa que
    // un reflejo afortunado le deja pasar.
    const result = analyzeThreshold(
      cloud(500, 0.7, 0.99),
      cloud(400, -0.1, 0.36),
      0.38,
    );

    expect(result.verdict).toBe('AJUSTADO');
    expect(result.marginBelow).toBeCloseTo(0.02, 4);
    expect(result.marginAbove).toBeCloseTo(0.32, 4);
  });

  it('ajustado si SOLO se estrecha el lado de los legítimos', () => {
    // El lado molesto: gente que se queda en la puerta en cuanto
    // empeore la luz.
    const result = analyzeThreshold(
      cloud(500, 0.4, 0.99),
      cloud(400, -0.1, 0.1),
      0.38,
    );

    expect(result.verdict).toBe('AJUSTADO');
    expect(result.marginAbove).toBeCloseTo(0.02, 4);
  });

  it('solapado cuando las nubes se pisan', () => {
    // No puede salir de la auditoría —el umbral las parte— pero sí de
    // un conjunto etiquetado a mano, y entonces es el hallazgo más
    // importante: no hay umbral bueno, hay que arreglar la captura.
    const result = analyzeThreshold(
      cloud(50, 0.2, 0.99),
      cloud(50, -0.1, 0.45),
      0.38,
    );

    expect(result.verdict).toBe('SOLAPADO');
    expect(result.separation).toBeLessThan(0);
  });

  it('trata como solapado el caso en que las nubes se tocan', () => {
    const result = analyzeThreshold(
      cloud(10, 0.38, 0.9),
      cloud(10, 0.0, 0.38),
      0.38,
    );

    expect(result.verdict).toBe('SOLAPADO');
    expect(result.separation).toBe(0);
  });
});

describe('analyzeThreshold · sin datos suficientes', () => {
  it('no afirma nada con un despliegue recién estrenado', () => {
    const result = analyzeThreshold(cloud(0, null, null), cloud(0, null, null), 0.38);

    expect(result.verdict).toBe('SIN_DATOS');
    expect(result.separation).toBeNull();
    expect(result.marginBelow).toBeNull();
    expect(result.marginAbove).toBeNull();
  });

  it('no calcula separación con una sola de las dos nubes', () => {
    // Con solo accesos concedidos no hay nada de lo que separarlos,
    // aunque sí se puede decir cuánto margen tuvieron.
    const result = analyzeThreshold(REAL_RECOGNIZED, cloud(0, null, null), 0.38);

    expect(result.verdict).toBe('SIN_DATOS');
    expect(result.separation).toBeNull();
    expect(result.marginAbove).toBeCloseTo(0.0355, 4);
    expect(result.marginBelow).toBeNull();
  });
});

describe('analyzeThreshold · advertencia de método', () => {
  it('acompaña siempre al resultado', () => {
    // Va en la respuesta y no solo en un comentario del código porque
    // quien mira el panel no lee el código, y sin ese aviso es fácil
    // leer el gráfico como si midiera tasas de error.
    const result = analyzeThreshold(REAL_RECOGNIZED, REAL_UNRECOGNIZED, 0.38);

    expect(result.caveat).toContain('no');
    expect(result.caveat).toContain('tasas de error');
  });

  it('devuelve el umbral analizado, no uno escrito a mano', () => {
    expect(analyzeThreshold(REAL_RECOGNIZED, REAL_UNRECOGNIZED, 0.5).threshold)
      .toBe(0.5);
  });
});
