import { parseAccessGrantedEvent } from './access-event.parser';

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
