import { describe, expect, it } from 'vitest';

import { cn, formatDuration, greetingFor } from './utils';

/**
 * Las funciones de presentación.
 *
 * Parecen triviales y no lo son del todo: `formatDuration` decide cómo
 * se le enseña a alguien cuántas horas lleva trabajadas, y ese número
 * sale de una hoja de horas. Redondear mal no rompe nada visiblemente,
 * solo hace que la cifra no cuadre con la del backend.
 */

describe('formatDuration', () => {
  it('por debajo de una hora solo enseña minutos', () => {
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(59)).toBe('0 min');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(3_599)).toBe('59 min');
  });

  it('a partir de la hora enseña ambas, con el minuto a dos cifras', () => {
    // Los dos dígitos importan: "6 h 5 min" y "6 h 05 min" se leen
    // distinto en una columna de horas.
    expect(formatDuration(3_600)).toBe('1 h 00 min');
    expect(formatDuration(3_900)).toBe('1 h 05 min');
    expect(formatDuration(24_120)).toBe('6 h 42 min');
  });

  it('TRUNCA los segundos, no los redondea', () => {
    // Es deliberado y está explicado en la función: el backend cuenta en
    // segundos para no perder minutos al redondear en cada transición, y
    // aquí se recorta una sola vez. Si esto empezara a redondear hacia
    // arriba, la suma de los tramos dejaría de cuadrar con el total.
    expect(formatDuration(119)).toBe('1 min');
    expect(formatDuration(3_659)).toBe('1 h 00 min');
  });

  it('no enseña tiempos negativos', () => {
    // Un reloj desajustado entre servicios puede dar una diferencia
    // negativa. Mejor cero que "-1 h 59 min" en la cara de alguien.
    expect(formatDuration(-500)).toBe('0 min');
  });

  it('aguanta jornadas de más de un día sin desbordar a otro formato', () => {
    expect(formatDuration(30 * 3_600)).toBe('30 h 00 min');
  });
});

describe('greetingFor', () => {
  const alas = (hora: number) => new Date(2026, 8, 13, hora, 30);

  it('cambia en los cortes correctos', () => {
    expect(greetingFor(alas(0))).toBe('Buenos días');
    expect(greetingFor(alas(11))).toBe('Buenos días');
    expect(greetingFor(alas(12))).toBe('Buenas tardes');
    expect(greetingFor(alas(19))).toBe('Buenas tardes');
    expect(greetingFor(alas(20))).toBe('Buenas noches');
    expect(greetingFor(alas(23))).toBe('Buenas noches');
  });

  it('saluda a quien entra en el turno de noche', () => {
    // El sistema contempla turnos nocturnos —la jornada se imputa al día
    // local de la sede, ver el contrato del evento—, así que las tres de
    // la mañana son una hora normal de fichar aquí.
    expect(greetingFor(alas(3))).toBe('Buenos días');
  });
});

describe('cn', () => {
  it('resuelve conflictos de Tailwind quedándose con el último', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('descarta los valores falsos de las clases condicionales', () => {
    expect(cn('base', false && 'oculto', undefined, 'extra')).toBe('base extra');
  });
});
