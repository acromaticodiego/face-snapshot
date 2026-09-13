import {
  parseAccessGrantedEvent,
  traceparentDelMensaje,
} from './access-event.parser';

/**
 * El bus es una frontera entre procesos que se despliegan por
 * separado: el tipo de TypeScript no vale de nada al otro lado de la
 * red. Estas pruebas fijan qué se acepta y, sobre todo, qué se rechaza
 * sin llegar a escribir nada.
 */

const VALID = {
  eventId: '11111111-1111-4111-8111-111111111111',
  type: 'AccessGranted',
  occurredAt: '2026-09-12T14:00:00.000Z',
  personId: '22222222-2222-4222-8222-222222222222',
  personName: 'Diego Ossa',
  siteId: '33333333-3333-4333-8333-333333333333',
  siteName: 'Sede Principal',
  siteTimezone: 'America/Bogota',
  zoneId: '44444444-4444-4444-8444-444444444444',
  zoneName: 'Oficinas',
  zoneShiftEffect: 'WORK',
  accessPointId: '55555555-5555-4555-8555-555555555555',
  accessPointName: 'Entrada Principal',
  direction: 'IN',
  stillInsideSite: true,
  anomaly: null,
};

const message = (payload: unknown) => [
  'type',
  'AccessGranted',
  'data',
  JSON.stringify(payload),
];

describe('parseAccessGrantedEvent', () => {
  it('acepta un evento completo', () => {
    expect(parseAccessGrantedEvent(message(VALID))).toEqual(VALID);
  });

  it('rechaza un evento al que le falta un campo', () => {
    // Sin esta comprobación, la ausencia de `stillInsideSite` se
    // convertiría en `undefined` y toda salida abriría una pausa.
    const { stillInsideSite, ...incomplete } = VALID;
    expect(parseAccessGrantedEvent(message(incomplete))).toBeNull();
  });

  it('rechaza un valor fuera del enumerado', () => {
    expect(
      parseAccessGrantedEvent(message({ ...VALID, zoneShiftEffect: 'SIESTA' })),
    ).toBeNull();
  });

  it('rechaza un JSON roto sin lanzar', () => {
    // Quien llama tiene que poder distinguir "no se entiende,
    // descártalo" de "falló la base de datos, reinténtalo": el primero
    // no debe reintentarse nunca.
    expect(parseAccessGrantedEvent(['type', 'X', 'data', '{no'])).toBeNull();
  });

  it('rechaza un mensaje sin el campo data', () => {
    expect(parseAccessGrantedEvent(['type', 'AccessGranted'])).toBeNull();
  });

  it('rechaza un mensaje vacío', () => {
    expect(parseAccessGrantedEvent([])).toBeNull();
  });

  it('acepta una anomalía de anti-passback', () => {
    const event = parseAccessGrantedEvent(
      message({ ...VALID, anomaly: 'ANTIPASSBACK_SOFT' }),
    );

    expect(event?.anomaly).toBe('ANTIPASSBACK_SOFT');
  });
});

/**
 * El contexto de traza cruza el bus en un campo aparte del payload.
 *
 * Estas pruebas fijan justo eso: que leerlo no depende de la posicion
 * del campo, y sobre todo que un mensaje SIN contexto es normal y no un
 * error. Todo lo publicado antes de la Fase 4, y todo lo que se
 * publique con la telemetria apagada, llega sin el; si esto devolviera
 * algo distinto de `null`, el consumidor intentaria colgar el span de
 * un padre inventado.
 */
describe('traceparentDelMensaje', () => {
  const TRACEPARENT =
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  it('lee el traceparent venga en la posicion que venga', () => {
    expect(
      traceparentDelMensaje([
        'type',
        'AccessGranted',
        'data',
        '{}',
        'traceparent',
        TRACEPARENT,
      ]),
    ).toBe(TRACEPARENT);

    expect(
      traceparentDelMensaje([
        'traceparent',
        TRACEPARENT,
        'type',
        'AccessGranted',
      ]),
    ).toBe(TRACEPARENT);
  });

  it('devuelve null si el mensaje no lo trae', () => {
    // Es el caso de todo lo publicado con la telemetria apagada. Tiene
    // que procesarse igual, sin span y sin ruido.
    expect(traceparentDelMensaje(['type', 'AccessGranted', 'data', '{}'])).toBeNull();
  });

  it('trata un traceparent vacio como ausente', () => {
    expect(traceparentDelMensaje(['traceparent', ''])).toBeNull();
  });

  it('no se cae con una lista de campos impar', () => {
    // Un mensaje malformado no puede tumbar al consumidor: bloquearia
    // la cola detras de el.
    expect(traceparentDelMensaje(['traceparent'])).toBeNull();
    expect(traceparentDelMensaje([])).toBeNull();
  });
});
