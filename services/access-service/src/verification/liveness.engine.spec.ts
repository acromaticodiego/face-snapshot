import {
  judgeFrame,
  type LivenessEvidence,
  type LivenessPolicy,
} from './liveness.engine';

/**
 * La política de detección de vida.
 *
 * Lo que estas pruebas fijan no es si el modelo acierta —eso se mide
 * con imágenes, y se mide en `scripts/measure-liveness.mjs`— sino las
 * DECISIONES que se toman con su número, que sí son código de este
 * proyecto:
 *
 *  · que `SOFT` no deniega nunca, porque es el modo por defecto y lo
 *    que falta por probar son ataques enteros, no precisión;
 *  · que la ausencia de evidencia no es sospecha, porque si lo fuera un
 *    despliegue escalonado cerraría todas las puertas;
 *  · y que un `spoofScore` que no es un número no cuenta como cero,
 *    porque un cero significa «ataque segurísimo».
 *
 * La robustez ante un frame ruidoso NO se prueba aquí porque no vive
 * aquí: un frame sospechoso no acumula voto, y la ventana de votación
 * —que ya está probada— es la que exige 3 limpios de 5.
 */

const politica = (extra: Partial<LivenessPolicy> = {}): LivenessPolicy => ({
  mode: 'HARD',
  minSpoofScore: 0.6,
  ...extra,
});

// Valores reales del conjunto de ataque, no inventados: la media de las
// 40 caras reales, la peor de ellas, la media de los 38 ataques y el
// mejor de ellos, en la variante de 640 px que es la que el terminal
// envía. El umbral de 0.60 cae entre los dos casos peores.
const caraReal: LivenessEvidence = { spoofScore: 0.9851 };
const caraRealPeor: LivenessEvidence = { spoofScore: 0.7769 };
const pantalla: LivenessEvidence = { spoofScore: 0.1187 };
const pantallaMejor: LivenessEvidence = { spoofScore: 0.5388 };

describe('judgeFrame', () => {
  it('acepta una cara real', () => {
    expect(judgeFrame(caraReal, politica())).toEqual({
      suspicious: false,
      reason: null,
    });
  });

  it('acepta la PEOR cara real del conjunto medido', () => {
    // Si esta se rechazara, el umbral por defecto estaría dejando fuera
    // a gente de verdad: 0.7769 lo dio una persona delante de la
    // cámara, no un ataque.
    expect(judgeFrame(caraRealPeor, politica()).suspicious).toBe(false);
  });

  it('sospecha de una foto en la pantalla de un móvil', () => {
    expect(judgeFrame(pantalla, politica()).reason).toBe('SPOOF_MODEL');
  });

  it('sospecha también del MEJOR ataque del conjunto medido', () => {
    // Es el que se cuela si se usa la decisión nativa del modelo
    // (umbral 0.5): el móvil llenando el encuadre, pantalla brillante y
    // marco casi invisible. Con 0.60 no pasa. Esta prueba es la que
    // justifica que el defecto no sea 0.5.
    expect(judgeFrame(pantallaMejor, politica()).reason).toBe('SPOOF_MODEL');
  });

  it('SIN EVIDENCIA NO HAY SOSPECHA', () => {
    // Un Vision Service anterior a esta fase no envía medidas. Si la
    // ausencia contara como ataque, actualizar los servicios en
    // distinto orden dejaría a toda la plantilla fuera del edificio.
    expect(judgeFrame(undefined, politica()).suspicious).toBe(false);
  });

  it('un objeto de evidencia SIN spoofScore tampoco es sospecha', () => {
    // El caso del despliegue escalonado en su versión fina: un Vision
    // Service de la Fase 6 manda `liveness` con las dos señales viejas
    // y sin la nueva. El objeto existe; el número, no.
    const soloSenalesViejas = {
      detailRatio: 0.47,
      patternPeak: 18.6,
    } as LivenessEvidence;
    expect(judgeFrame(soloSenalesViejas, politica()).suspicious).toBe(false);
  });

  it('un spoofScore nulo NO se toma como cero', () => {
    // El Vision Service lo envía ausente cuando falla al medirlo. Si
    // aquí se leyera como 0, un fallo de medida sería indistinguible
    // del ataque perfecto, y en HARD dejaría a una persona real en la
    // calle. La otra mitad de esta decisión está en `spoof.py`.
    expect(judgeFrame({ spoofScore: null }, politica()).suspicious).toBe(false);
    expect(judgeFrame({ spoofScore: NaN }, politica()).suspicious).toBe(false);
  });

  it('las señales viejas ya no deciden nada', () => {
    // Valores que con la política anterior habrían sido sospechosos por
    // los dos motivos a la vez, acompañando a una cara real. Se dejan
    // pasar: están refutadas (ADR 0014) y el motor no las mira.
    const viejasEnRojo = {
      spoofScore: 0.98,
      detailRatio: 0.05,
      patternPeak: 500,
    } as LivenessEvidence;
    expect(judgeFrame(viejasEnRojo, politica()).suspicious).toBe(false);
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
