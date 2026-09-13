import {
  judgeFrame,
  type LivenessEvidence,
  type LivenessPolicy,
} from './liveness.engine';

/**
 * La política de detección de vida.
 *
 * Lo que estas pruebas fijan no es si la señal funciona —eso no se
 * puede saber sin un conjunto de ataques reales— sino las DECISIONES
 * que se toman con ella, que sí son código de este proyecto:
 *
 *  · que `SOFT` no deniega nunca, porque es el modo por defecto y
 *    denegar con una señal sin calibrar dejaría gente en la calle;
 *  · que la ausencia de evidencia no es sospecha, porque si lo fuera un
 *    despliegue escalonado cerraría todas las puertas;
 *
 * La robustez ante un frame ruidoso NO se prueba aquí porque no vive
 * aquí: un frame sospechoso no acumula voto, y la ventana de votación
 * —que ya está probada— es la que exige 3 limpios de 5.
 */

const politica = (extra: Partial<LivenessPolicy> = {}): LivenessPolicy => ({
  mode: 'HARD',
  minDetailRatio: 0.35,
  maxPatternPeak: 60,
  ...extra,
});

const limpio: LivenessEvidence = { detailRatio: 0.56, patternPeak: 14 };
const reimpresion: LivenessEvidence = { detailRatio: 0.32, patternPeak: 38 };
const pantalla: LivenessEvidence = { detailRatio: 0.63, patternPeak: 149 };

describe('judgeFrame', () => {
  it('acepta una captura directa', () => {
    expect(judgeFrame(limpio, politica())).toEqual({
      suspicious: false,
      reason: null,
    });
  });

  it('sospecha de poco detalle: una foto de una foto', () => {
    expect(judgeFrame(reimpresion, politica()).reason).toBe('LOW_DETAIL');
  });

  it('sospecha de un patrón periódico: una pantalla', () => {
    expect(judgeFrame(pantalla, politica()).reason).toBe('PERIODIC_PATTERN');
  });

  it('cuando se dan las dos, gana el patrón por ser más específico', () => {
    // Poca textura hay en muchas capturas malas; un patrón periódico
    // solo lo produce algo fabricado. El motivo que se registra es el
    // que le sirve a quien investigue el incidente.
    const ambas: LivenessEvidence = { detailRatio: 0.1, patternPeak: 500 };
    expect(judgeFrame(ambas, politica()).reason).toBe('PERIODIC_PATTERN');
  });

  it('SIN EVIDENCIA NO HAY SOSPECHA', () => {
    // Un Vision Service anterior a esta fase no envía medidas. Si la
    // ausencia contara como ataque, actualizar los servicios en
    // distinto orden dejaría a toda la plantilla fuera del edificio.
    expect(judgeFrame(undefined, politica()).suspicious).toBe(false);
  });

  it('en OFF no mira nada', () => {
    expect(judgeFrame(pantalla, politica({ mode: 'OFF' })).suspicious).toBe(false);
  });

  it('en SOFT sí marca el frame como sospechoso', () => {
    // SOFT no es "no mirar": es mirar y anotar. Quien decide no
    // denegar es el servicio de verificación, no este motor, y eso es
    // lo que permite recoger datos con los que calibrar antes de
    // encender la denegación.
    expect(judgeFrame(pantalla, politica({ mode: 'SOFT' })).suspicious).toBe(true);
  });
});
