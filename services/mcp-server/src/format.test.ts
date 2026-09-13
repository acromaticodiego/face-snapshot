/**
 * Pruebas del formateo, que es donde vive casi toda la lógica de este
 * servidor.
 *
 * POR QUE `node --test` Y NO JEST
 * ──────────────────────────────
 * Este paquete es ESM puro y no arrastra el andamiaje de NestJS. El
 * corredor de pruebas de Node viene en la propia plataforma: no añade
 * una dependencia de desarrollo ni un preset de transformación para
 * probar cuatro funciones sin estado.
 *
 * QUE SE PRUEBA, Y POR QUE ESO
 * ────────────────────────────
 * Lo que un modelo de lenguaje va a leer y repetirle a una persona. Si
 * este texto miente, miente el resumen que alguien escuche, y esa es
 * la única forma en que este servidor puede hacer daño: no puede
 * escribir nada, pero sí puede contar mal lo que pasó.
 *
 * Los dos casos que más importan están aquí: que no se confunda estar
 * dentro con tener la jornada abierta, y que una cita sin respaldo
 * salga marcada.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  duracion,
  formatHandovers,
  formatPending,
  formatPresence,
  formatShifts,
  hora,
} from './format.js';

describe('duracion', () => {
  it('separa horas y minutos', () => {
    assert.equal(duracion(26_000), '7 h 13 min');
  });

  it('omite las horas cuando no llega a una', () => {
    assert.equal(duracion(900), '15 min');
  });

  it('trata la ausencia y lo imposible como cero', () => {
    assert.equal(duracion(undefined), '0 min');
    assert.equal(duracion(-5), '0 min');
  });
});

describe('hora', () => {
  it('deja la fecha legible y en UTC declarado', () => {
    assert.equal(hora('2026-09-13T14:50:52.677Z'), '2026-09-13 14:50 UTC');
  });

  it('no inventa nada si no es una fecha', () => {
    assert.equal(hora('mañana'), 'mañana');
    assert.equal(hora(null), 'sin hora');
  });
});

describe('formatPresence', () => {
  const presencia = {
    items: [
      {
        personId: 'p1',
        zoneName: 'Oficinas',
        zoneShiftEffect: 'WORK',
        lastDirection: 'IN',
        lastPassageAt: '2026-09-13T14:50:52.677Z',
      },
    ],
    occupancyByZone: { z1: { zoneName: 'Oficinas', count: 1 } },
    totalPeople: 1,
  };

  it('pone el nombre cuando la jornada lo da', () => {
    const texto = formatPresence(presencia, {
      items: [
        {
          personId: 'p1',
          personName: 'Diego Ossa',
          state: 'EN_TURNO',
          since: '2026-09-13T06:00:00Z',
          startedAt: '2026-09-13T06:00:00Z',
          siteName: 'Sede Principal',
        },
      ],
      countsByState: { EN_TURNO: 1 },
    });

    assert.match(texto, /Diego Ossa/);
    assert.match(texto, /Oficinas/);
    // El identificador no le sirve de nada a quien lee.
    assert.doesNotMatch(texto, /\bp1\b/);
  });

  it('sigue funcionando si no se pudieron leer las jornadas', () => {
    // El aforo es lo que se ha pedido: perderlo porque una segunda
    // lectura falló sería cambiar una respuesta parcial por ninguna.
    const texto = formatPresence(presencia, null);
    assert.match(texto, /1 persona\(s\) dentro/);
    assert.match(texto, /sin jornada abierta/);
  });

  it('avisa de que dentro no es lo mismo que jornada abierta', () => {
    // Es la distinción central del sistema (ADR 0007). Sin esta nota,
    // un modelo dirá que alguien está dentro cuando solo tiene la
    // jornada abierta.
    assert.match(formatPresence(presencia, null), /EN_PAUSA/);
  });

  it('lo dice claro cuando no hay nadie', () => {
    const texto = formatPresence(
      { items: [], occupancyByZone: {}, totalPeople: 0 },
      null,
    );
    assert.equal(texto, 'No consta nadie dentro ahora mismo.');
  });
});

describe('formatShifts', () => {
  it('resume por estado y detalla', () => {
    const texto = formatShifts({
      items: [
        {
          personId: 'p1',
          personName: 'Diego Ossa',
          state: 'EN_DESCANSO',
          since: '2026-09-13T12:00:00Z',
          startedAt: '2026-09-13T06:00:00Z',
          siteName: 'Sede Principal',
          workedSeconds: 21_600,
        },
      ],
      countsByState: { EN_DESCANSO: 1 },
    });

    assert.match(texto, /EN_DESCANSO: 1/);
    assert.match(texto, /trabajado 6 h 0 min/);
  });

  it('lo dice claro cuando no hay jornadas', () => {
    assert.equal(
      formatShifts({ items: [], countsByState: {} }),
      'No hay ninguna jornada abierta.',
    );
  });
});

describe('formatPending', () => {
  const base = {
    title: 'Ruido en el ascensor',
    category: 'MANTENIMIENTO',
    severity: 'MEDIA',
    mentionedTime: null,
    origin: 'PROPUESTA_EDITADA',
    entry: {
      id: 'e1',
      personName: 'Diego Ossa',
      siteName: 'Sede Principal',
      businessDate: '2026-09-13T00:00:00.000Z',
      coversTo: '2026-09-13T18:30:00.000Z',
    },
  };

  it('marca una cita que el modelo no pudo respaldar', () => {
    // Es lo único que este sistema sabe detectar sobre la invención de
    // un modelo, y tiene que llegar hasta el final de la cadena.
    const texto = formatPending({
      items: [{ ...base, quote: 'el ascensor se cayó', quoteVerified: false }],
      total: 1,
      sinceDays: 7,
    });
    assert.match(texto, /CITA NO RESPALDADA/);
  });

  it('no marca una cita respaldada', () => {
    const texto = formatPending({
      items: [{ ...base, quote: 'sigue haciendo ruido', quoteVerified: true }],
      total: 1,
      sinceDays: 7,
    });
    assert.doesNotMatch(texto, /NO RESPALDADA/);
    assert.match(texto, /sigue haciendo ruido/);
  });

  it('dice quién lo dejó pendiente', () => {
    const texto = formatPending({
      items: [{ ...base, quote: null, quoteVerified: false }],
      total: 1,
      sinceDays: 7,
    });
    assert.match(texto, /lo dejó Diego Ossa/);
  });

  it('lo dice claro cuando no queda nada', () => {
    const texto = formatPending({ items: [], total: 0, sinceDays: 7 });
    assert.match(texto, /No queda ninguna incidencia/);
  });
});

describe('formatHandovers', () => {
  const parte = {
    id: 'h1',
    personName: 'Diego Ossa',
    siteName: 'Sede Principal',
    businessDate: '2026-09-13T00:00:00.000Z',
    coversFrom: '2026-09-13T08:00:00.000Z',
    coversTo: '2026-09-13T18:30:00.000Z',
    source: 'DICTADO',
    summary: 'Turno sin novedades reseñables.',
    incidents: [
      { title: 'Sensor del muelle', category: 'ALARMA', severity: 'BAJA' },
    ],
  };

  it('incluye el cruce con las puertas', () => {
    const texto = formatHandovers({
      items: [
        {
          ...parte,
          accessSnapshot: {
            totals: { attempts: 266, granted: 9, denied: 257 },
            byReason: [{ reason: 'BELOW_THRESHOLD', count: 252 }],
          },
        },
      ],
      total: 1,
    });

    assert.match(texto, /266 intentos, 9 concedidos, 257 denegados/);
    assert.match(texto, /BELOW_THRESHOLD 252/);
  });

  it('dice cuando el parte se firmó sin cruce', () => {
    // Callarlo daría a entender que no pasó nada en esa franja, que es
    // muy distinto de no haberlo podido preguntar.
    const texto = formatHandovers({
      items: [{ ...parte, accessSnapshot: null }],
      total: 1,
    });
    assert.match(texto, /sin cruce de accesos/);
  });

  it('conserva el identificador del parte, que sí sirve para pedir más', () => {
    const texto = formatHandovers({
      items: [{ ...parte, accessSnapshot: null }],
      total: 1,
    });
    assert.match(texto, /id del parte: h1/);
  });
});
