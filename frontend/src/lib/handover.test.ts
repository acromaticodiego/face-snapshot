import { describe, expect, it } from 'vitest';

import type { ProposedIncident } from './api';
import {
  blockingReason,
  defaultPeriod,
  emptyIncident,
  fromProposed,
  originOf,
  toPayload,
  type EditableIncident,
} from './handover';

/**
 * Lo que se prueba, y por qué eso.
 *
 * Este módulo decide qué se guarda en un registro que después no se
 * puede editar. Dos reglas importan por encima del resto:
 *
 *  · **De dónde salió cada incidencia.** Solo el cliente lo sabe, y es
 *    el dato con el que dentro de unos meses se podrá responder si el
 *    modelo aporta algo. Calculado mal, responde a otra pregunta.
 *
 *  · **Qué viaja y qué no.** Una incidencia escrita a mano no puede
 *    salir marcada como respaldada por una cita del modelo, y un parte
 *    sin audio no puede decir que fue dictado.
 *
 * Nada de esto toca la red ni el micrófono.
 */

const PROPUESTA: ProposedIncident = {
  titulo: 'Ruido en el ascensor del ala norte',
  categoria: 'MANTENIMIENTO',
  gravedad: 'MEDIA',
  horaMencionada: 'las tres y cuarto',
  requiereSeguimiento: true,
  citaLiteral: 'El ascensor del ala norte sigue haciendo ruido',
  citaVerificada: true,
};

describe('originOf', () => {
  it('una propuesta intacta se firma como aceptada', () => {
    expect(originOf(fromProposed(PROPUESTA, 'k1'))).toBe('PROPUESTA_ACEPTADA');
  });

  it('cambiar el título la marca como editada', () => {
    const i = { ...fromProposed(PROPUESTA, 'k1'), title: 'Ascensor averiado' };
    expect(originOf(i)).toBe('PROPUESTA_EDITADA');
  });

  it('cambiar la gravedad la marca como editada', () => {
    const i = { ...fromProposed(PROPUESTA, 'k1'), severity: 'ALTA' as const };
    expect(originOf(i)).toBe('PROPUESTA_EDITADA');
  });

  it('cambiar si queda pendiente la marca como editada', () => {
    const i = { ...fromProposed(PROPUESTA, 'k1'), requiresFollowUp: false };
    expect(originOf(i)).toBe('PROPUESTA_EDITADA');
  });

  it('un espacio de más no es una corrección', () => {
    // Contarlo ensuciaría el único dato que dice si el modelo acierta.
    const i = {
      ...fromProposed(PROPUESTA, 'k1'),
      title: '  Ruido en el ascensor del ala norte  ',
    };
    expect(originOf(i)).toBe('PROPUESTA_ACEPTADA');
  });

  it('lo que escribe la persona se firma como añadido por ella', () => {
    expect(originOf(emptyIncident('k9'))).toBe('ANADIDA_POR_PERSONA');
  });

  it('la propuesta guardada no se mueve aunque la incidencia se edite en sitio', () => {
    // La propiedad que importa: escribir sobre la incidencia no puede
    // arrastrar la propuesta contra la que se compara, porque entonces
    // nada parecería editado nunca.
    //
    // Se muta EN SITIO en lugar de crear un objeto nuevo con un
    // spread, que es el caso fácil y el que no prueba nada.
    const incidencia = fromProposed(PROPUESTA, 'k1');
    incidencia.title = 'Otro título';

    expect(incidencia.proposed?.title).toBe(PROPUESTA.titulo);
    expect(originOf(incidencia)).toBe('PROPUESTA_EDITADA');
  });
});

describe('blockingReason', () => {
  const base = {
    siteId: '11111111-1111-4111-8111-111111111111',
    summary: 'Turno sin novedades.',
    incidents: [] as EditableIncident[],
  };

  it('sin jornada abierta no se puede firmar', () => {
    expect(blockingReason({ ...base, siteId: null })).toBe('SIN_JORNADA');
  });

  it('sin resumen no se puede firmar', () => {
    expect(blockingReason({ ...base, summary: '   ' })).toBe('SIN_RESUMEN');
  });

  it('una incidencia sin título bloquea', () => {
    expect(blockingReason({ ...base, incidents: [emptyIncident('k1')] })).toBe(
      'INCIDENCIA_SIN_TITULO',
    );
  });

  it('un parte SIN incidencias es válido', () => {
    // La mayoría de los turnos no tienen ninguna. Exigir al menos una
    // empujaría a inventarse algo, que es lo contrario de lo que se
    // busca.
    expect(blockingReason(base)).toBeNull();
  });

  it('un parte con una incidencia completa es válido', () => {
    expect(
      blockingReason({ ...base, incidents: [fromProposed(PROPUESTA, 'k1')] }),
    ).toBeNull();
  });
});

describe('toPayload', () => {
  const base = {
    siteId: '11111111-1111-4111-8111-111111111111',
    coversFrom: '2026-09-13T08:00:00.000Z',
    coversTo: '2026-09-13T16:00:00.000Z',
    transcript: 'El ascensor del ala norte sigue haciendo ruido.',
    summary: '  Turno tranquilo.  ',
    transcriptionModel: 'nova-3',
    structuringModel: 'gemini-3.8-flash',
    incidents: [fromProposed(PROPUESTA, 'k1')],
  };

  it('un parte con transcripción se firma como DICTADO y lleva los modelos', () => {
    const payload = toPayload(base);
    expect(payload.source).toBe('DICTADO');
    expect(payload.transcript).toBeTruthy();
    expect(payload.transcriptionModel).toBe('nova-3');
    expect(payload.structuringModel).toBe('gemini-3.8-flash');
  });

  it('un parte sin transcripción se firma como ESCRITO y sin modelos', () => {
    // Decir DICTADO sin transcripción sería afirmar que hubo audio sin
    // dejar rastro de lo que se dijo. El servidor lo rechaza.
    const payload = toPayload({ ...base, transcript: null });
    expect(payload.source).toBe('ESCRITO');
    expect(payload.transcript).toBeUndefined();
    expect(payload.transcriptionModel).toBeUndefined();
    expect(payload.structuringModel).toBeUndefined();
  });

  it('una transcripción en blanco cuenta como no haberla', () => {
    expect(toPayload({ ...base, transcript: '   ' }).source).toBe('ESCRITO');
  });

  it('recorta el resumen y los títulos', () => {
    const payload = toPayload(base);
    expect(payload.summary).toBe('Turno tranquilo.');
    expect(payload.incidents[0].title).toBe(PROPUESTA.titulo);
  });

  it('una incidencia escrita a mano nunca sale respaldada por el modelo', () => {
    // No tiene cita que verificar, así que afirmar lo contrario sería
    // atribuirle al modelo algo que no dijo.
    const payload = toPayload({
      ...base,
      incidents: [{ ...emptyIncident('k9'), title: 'Cámara borrosa' }],
    });

    expect(payload.incidents[0].origin).toBe('ANADIDA_POR_PERSONA');
    expect(payload.incidents[0].quoteVerified).toBe(false);
    expect(payload.incidents[0].quote).toBeUndefined();
  });

  it('aunque una incidencia a mano llegue marcada, la marca se cae', () => {
    // La interfaz no puede producir esto hoy, pero el invariante no
    // depende de la interfaz: sin `proposed` no hubo modelo que
    // respaldara nada, y la marca solo significa algo viniendo de él.
    //
    // Se comprobó que hacía falta: sin esta condición, los demás casos
    // pasaban igual porque una incidencia a mano ya nace con la marca
    // a falso.
    const payload = toPayload({
      ...base,
      incidents: [
        {
          ...emptyIncident('k9'),
          title: 'Cámara borrosa',
          quote: 'algo que nadie dijo',
          quoteVerified: true,
        },
      ],
    });

    expect(payload.incidents[0].quoteVerified).toBe(false);
  });

  it('conserva que una cita del modelo no estaba respaldada', () => {
    // Es lo único que el sistema sabe detectar sobre la invención de un
    // modelo: tiene que llegar hasta el registro firmado.
    const payload = toPayload({
      ...base,
      incidents: [fromProposed({ ...PROPUESTA, citaVerificada: false }, 'k1')],
    });
    expect(payload.incidents[0].quoteVerified).toBe(false);
    expect(payload.incidents[0].quote).toBeTruthy();
  });

  it('omite la hora mencionada cuando está vacía', () => {
    const payload = toPayload({
      ...base,
      incidents: [{ ...fromProposed(PROPUESTA, 'k1'), mentionedTime: '  ' }],
    });
    expect(payload.incidents[0].mentionedTime).toBeUndefined();
  });
});

describe('defaultPeriod', () => {
  const ahora = new Date('2026-09-13T16:00:00.000Z');

  it('propone desde el inicio de la jornada hasta ahora', () => {
    const periodo = defaultPeriod('2026-09-13T08:00:00.000Z', ahora);
    expect(periodo.coversFrom).toBe('2026-09-13T08:00:00.000Z');
    expect(periodo.coversTo).toBe('2026-09-13T16:00:00.000Z');
  });

  it('recorta una jornada que lleve abierta más de 24 horas', () => {
    // El servidor rechaza periodos mayores de un día, y una jornada así
    // es una que nadie cerró. El parte no tiene por qué morir con ella.
    const periodo = defaultPeriod('2026-09-01T00:00:00.000Z', ahora);
    const duracionMs =
      new Date(periodo.coversTo).getTime() - new Date(periodo.coversFrom).getTime();

    expect(duracionMs).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(duracionMs).toBeGreaterThan(23 * 3600 * 1000);
  });

  it('sin jornada propone las últimas ocho horas', () => {
    const periodo = defaultPeriod(null, ahora);
    expect(periodo.coversFrom).toBe('2026-09-13T08:00:00.000Z');
  });
});
