import type { AccessPointContext } from '../policy/policy.repository';
import {
  buildAccessGrantedEvent,
  type GrantedPassage,
} from './passage.service';

/**
 * El evento es la frontera del servicio: un campo mal puesto aquí no
 * rompe nada en el Access Service, rompe en el Shift Service, horas
 * después y en otro proceso. Por eso el contrato se comprueba en el
 * lado que lo produce.
 */

const POINT: AccessPointContext = {
  accessPointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  accessPointName: 'Puerta Cafetería',
  accessPointActive: true,
  direction: 'BOTH',
  zoneId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  zoneName: 'Cafetería',
  zoneActive: true,
  antipassbackMode: 'OFF',
  shiftEffect: 'BREAK',
  siteId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  siteName: 'Sede Principal',
  timezone: 'America/Bogota',
};

function grant(overrides: Partial<GrantedPassage> = {}): GrantedPassage {
  return {
    personId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    personName: 'Diego Ossa',
    confidence: 0.91,
    cameraId: 'default',
    point: POINT,
    direction: 'IN',
    anomaly: null,
    sessionTtlMs: 900_000,
    now: new Date('2026-09-12T12:30:00.000Z'),
    ...overrides,
  };
}

describe('buildAccessGrantedEvent', () => {
  it('lleva el efecto de la zona sobre la jornada', () => {
    // Es lo que permite al Shift Service saber que esto es un descanso
    // y no trabajo, sin preguntarle nada al Access Service. Sin este
    // campo volveríamos a tener la llamada de vuelta que este diseño
    // evita.
    expect(buildAccessGrantedEvent(grant(), true).zoneShiftEffect).toBe('BREAK');
  });

  it('lleva los nombres además de los identificadores', () => {
    // Mismo criterio que la auditoría: el hecho debe seguir siendo
    // legible aunque mañana se renombre o se elimine la zona.
    const event = buildAccessGrantedEvent(grant(), true);

    expect(event.siteName).toBe('Sede Principal');
    expect(event.zoneName).toBe('Cafetería');
    expect(event.accessPointName).toBe('Puerta Cafetería');
  });

  it('registra el sentido resuelto del paso', () => {
    expect(buildAccessGrantedEvent(grant({ direction: 'OUT' }), true).direction).toBe(
      'OUT',
    );
  });

  it('propaga la anomalía del anti-passback blando', () => {
    // El consumidor la necesita: significa que la presencia venía
    // descuadrada y que ese paso puede no encajar con el anterior.
    const event = buildAccessGrantedEvent(
      grant({ anomaly: 'ANTIPASSBACK_SOFT' }),
      true,
    );

    expect(event.anomaly).toBe('ANTIPASSBACK_SOFT');
  });

  it('emite un identificador distinto por evento', () => {
    // Es la clave de idempotencia del consumidor. Si dos eventos la
    // compartieran, el segundo se descartaría como repetido y se
    // perdería un paso real.
    const first = buildAccessGrantedEvent(grant(), true);
    const second = buildAccessGrantedEvent(grant(), true);

    expect(first.eventId).not.toBe(second.eventId);
  });

  it('marca el instante del paso, no el de la publicación', () => {
    const event = buildAccessGrantedEvent(grant(), true);

    expect(event.occurredAt).toBe('2026-09-12T12:30:00.000Z');
  });

  it('dice si la persona sigue dentro de la sede tras el paso', () => {
    // Es lo que distingue "salio del laboratorio y sigue trabajando"
    // de "se fue a casa". Solo el Access Service puede responderlo,
    // porque solo el tiene la presencia.
    expect(
      buildAccessGrantedEvent(grant({ direction: 'OUT' }), true)
        .stillInsideSite,
    ).toBe(true);
    expect(
      buildAccessGrantedEvent(grant({ direction: 'OUT' }), false)
        .stillInsideSite,
    ).toBe(false);
  });

  it('lleva la zona horaria de la sede', () => {
    // La jornada se imputa al dia local de la sede, no al del
    // servidor: sin este campo, en Bogota todo lo fichado despues de
    // las 19:00 caeria en el dia siguiente.
    expect(buildAccessGrantedEvent(grant(), true).siteTimezone).toBe(
      'America/Bogota',
    );
  });

  it('sobrevive a una ida y vuelta por JSON', () => {
    // Viaja serializado por el bus: cualquier valor que no sea JSON
    // puro se perdería en el camino sin avisar.
    const event = buildAccessGrantedEvent(grant(), true);

    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
