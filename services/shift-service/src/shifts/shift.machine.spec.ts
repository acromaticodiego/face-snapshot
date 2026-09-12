import {
  applyPassage,
  businessDateOf,
  resolvePause,
  resolveStale,
  type PassageInput,
  type ShiftSnapshot,
  type ShiftState,
} from './shift.machine';

/**
 * De esta máquina salen las horas que se le pagan a alguien. Se prueba
 * con el mismo detalle que el motor de autorización del Access
 * Service: cada estado, cada transición, y los casos raros que son los
 * que de verdad rompen una hoja de horas —el turno de noche, la pausa
 * que nadie cierra, el evento que llega desordenado—.
 */

const AT = (iso: string) => new Date(iso);

function snapshot(overrides: Partial<ShiftSnapshot> = {}): ShiftSnapshot {
  const stateSince = overrides.stateSince ?? AT('2026-09-12T13:00:00Z');
  return {
    state: 'EN_TURNO',
    stateSince,
    lastSeenAt: stateSince,
    workedSeconds: 0,
    breakSeconds: 0,
    ...overrides,
  };
}

function passage(overrides: Partial<PassageInput> = {}): PassageInput {
  return {
    direction: 'IN',
    zoneShiftEffect: 'WORK',
    stillInsideSite: true,
    at: AT('2026-09-12T14:00:00Z'),
    ...overrides,
  };
}

describe('applyPassage · sin jornada abierta', () => {
  it('la primera entrada a una zona de trabajo abre la jornada', () => {
    expect(applyPassage(null, passage())).toEqual({
      action: 'OPEN',
      state: 'EN_TURNO',
    });
  });

  it('llegar directamente a la cafetería abre la jornada en descanso', () => {
    expect(
      applyPassage(null, passage({ zoneShiftEffect: 'BREAK' })),
    ).toEqual({ action: 'OPEN', state: 'EN_DESCANSO' });
  });

  it('entrar al parking no ficha', () => {
    // Una zona neutra no es ni trabajo ni descanso; abrir jornada al
    // aparcar contaría como trabajado el rato de subir al edificio.
    expect(
      applyPassage(null, passage({ zoneShiftEffect: 'NEUTRAL' })),
    ).toEqual({ action: 'RECORD_ONLY' });
  });

  it('una salida sin jornada abierta solo se anota', () => {
    // Es lo que produce el anti-passback blando el día que se estrena
    // el sistema: nadie ha "entrado" todavía. No se inventa una
    // jornada hacia atrás.
    expect(
      applyPassage(null, passage({ direction: 'OUT', stillInsideSite: false })),
    ).toEqual({ action: 'RECORD_ONLY' });
  });
});

describe('applyPassage · transiciones', () => {
  it('bajar a la cafetería pasa a descanso y computa lo trabajado', () => {
    const result = applyPassage(
      snapshot({ state: 'EN_TURNO', stateSince: AT('2026-09-12T13:00:00Z') }),
      passage({ zoneShiftEffect: 'BREAK', at: AT('2026-09-12T14:00:00Z') }),
    );

    expect(result).toEqual({
      action: 'UPDATE',
      state: 'EN_DESCANSO',
      workedDelta: 3600,
      breakDelta: 0,
    });
  });

  it('volver de la cafetería computa el descanso, no trabajo', () => {
    const result = applyPassage(
      snapshot({
        state: 'EN_DESCANSO',
        stateSince: AT('2026-09-12T14:00:00Z'),
      }),
      passage({
        direction: 'OUT',
        zoneShiftEffect: 'BREAK',
        stillInsideSite: true,
        at: AT('2026-09-12T14:30:00Z'),
      }),
    );

    expect(result).toEqual({
      action: 'UPDATE',
      state: 'EN_TURNO',
      workedDelta: 0,
      breakDelta: 1800,
    });
  });

  it('salir de la sede abre una pausa, no cierra la jornada', () => {
    // Es la decisión central del diseño: al salir no se puede saber si
    // la persona vuelve, así que no se adivina.
    const result = applyPassage(
      snapshot({ state: 'EN_TURNO', stateSince: AT('2026-09-12T13:00:00Z') }),
      passage({
        direction: 'OUT',
        stillInsideSite: false,
        at: AT('2026-09-12T14:00:00Z'),
      }),
    );

    expect(result).toEqual({
      action: 'UPDATE',
      state: 'EN_PAUSA',
      workedDelta: 3600,
      breakDelta: 0,
    });
  });

  it('salir del laboratorio y seguir en la sede no abre pausa', () => {
    // Salir de una zona no es salir del edificio. Sin `stillInsideSite`
    // el sistema abriría una pausa cada vez que alguien cambia de sala.
    const result = applyPassage(
      snapshot({ state: 'EN_TURNO' }),
      passage({ direction: 'OUT', stillInsideSite: true }),
    );

    expect(result).toEqual({ action: 'RECORD_ONLY' });
  });

  it('volver de una pausa reanuda el turno y la cuenta como descanso', () => {
    const result = applyPassage(
      snapshot({ state: 'EN_PAUSA', stateSince: AT('2026-09-12T14:00:00Z') }),
      passage({ at: AT('2026-09-12T14:45:00Z') }),
    );

    expect(result).toEqual({
      action: 'UPDATE',
      state: 'EN_TURNO',
      workedDelta: 0,
      breakDelta: 2700,
    });
  });

  it('entrar a otra zona de trabajo no interrumpe el turno', () => {
    const result = applyPassage(
      snapshot({ state: 'EN_TURNO' }),
      passage({ zoneShiftEffect: 'WORK' }),
    );

    expect(result).toEqual({ action: 'RECORD_ONLY' });
  });

  it('entrar al parking no saca a nadie de su turno', () => {
    expect(
      applyPassage(
        snapshot({ state: 'EN_TURNO' }),
        passage({ zoneShiftEffect: 'NEUTRAL' }),
      ),
    ).toEqual({ action: 'RECORD_ONLY' });
  });

  it('no suma tiempo negativo si dos eventos comparten instante', () => {
    const at = AT('2026-09-12T13:00:00Z');
    const result = applyPassage(
      snapshot({ state: 'EN_TURNO', stateSince: at }),
      passage({ zoneShiftEffect: 'BREAK', at }),
    );

    expect(result).toEqual({
      action: 'UPDATE',
      state: 'EN_DESCANSO',
      workedDelta: 0,
      breakDelta: 0,
    });
  });
});

describe('applyPassage · eventos desordenados', () => {
  it('descarta un evento anterior al estado actual', () => {
    // La entrega es "al menos una vez" y un reproceso puede traer algo
    // viejo. Aplicarlo restaría tiempo o movería la jornada hacia
    // atrás: la línea de tiempo prefiere un hueco a un dato falso.
    const result = applyPassage(
      snapshot({ state: 'EN_TURNO', stateSince: AT('2026-09-12T14:00:00Z') }),
      passage({ zoneShiftEffect: 'BREAK', at: AT('2026-09-12T13:00:00Z') }),
    );

    expect(result).toEqual({ action: 'IGNORE', reason: 'OUT_OF_ORDER' });
  });
});

describe('resolvePause', () => {
  const PAUSED = snapshot({
    state: 'EN_PAUSA',
    stateSince: AT('2026-09-12T18:00:00Z'),
  });

  it('no cierra nada mientras la pausa sea corta', () => {
    expect(
      resolvePause(PAUSED, AT('2026-09-12T18:20:00Z'), 1800),
    ).toBeNull();
  });

  it('cierra la jornada cuando la pausa se alarga', () => {
    expect(resolvePause(PAUSED, AT('2026-09-12T19:00:00Z'), 1800)).toEqual({
      endedAt: AT('2026-09-12T18:00:00Z'),
    });
  });

  it('la jornada termina cuando la persona salió, no cuando se detectó', () => {
    // Es la razón de ser del estado provisional: quien se va a las
    // 18:00 no puede aparecer trabajando hasta la medianoche solo
    // porque el reconciliador pase cada hora.
    const result = resolvePause(PAUSED, AT('2026-09-13T00:00:00Z'), 1800);

    expect(result?.endedAt).toEqual(AT('2026-09-12T18:00:00Z'));
  });

  it('no toca una jornada que no esté en pausa', () => {
    for (const state of ['EN_TURNO', 'EN_DESCANSO', 'FUERA'] as ShiftState[]) {
      expect(
        resolvePause(snapshot({ state }), AT('2026-09-13T00:00:00Z'), 1800),
      ).toBeNull();
    }
  });
});

describe('resolveStale', () => {
  it('no cierra una jornada normal', () => {
    const open = snapshot({
      state: 'EN_TURNO',
      stateSince: AT('2026-09-12T08:00:00Z'),
      lastSeenAt: AT('2026-09-12T13:00:00Z'),
    });

    expect(resolveStale(open, AT('2026-09-12T17:00:00Z'), 16 * 3600)).toBeNull();
  });

  it('cierra la jornada de quien se fue sin fichar', () => {
    // Sin esto, la hoja de horas mostraría jornadas de tres días y las
    // estadísticas dejarían de significar nada.
    const forgotten = snapshot({
      state: 'EN_TURNO',
      stateSince: AT('2026-09-12T08:00:00Z'),
      lastSeenAt: AT('2026-09-12T17:00:00Z'),
    });

    const result = resolveStale(forgotten, AT('2026-09-13T12:00:00Z'), 16 * 3600);

    expect(result).toEqual({
      endedAt: AT('2026-09-12T17:00:00Z'),
      workedDelta: 9 * 3600,
      breakDelta: 0,
    });
  });

  it('computa hasta el último movimiento y no hasta ahora', () => {
    // El hueco entre el último rastro y el momento de darse cuenta es
    // precisamente el que nadie puede afirmar que se trabajara.
    const forgotten = snapshot({
      state: 'EN_TURNO',
      stateSince: AT('2026-09-12T08:00:00Z'),
      lastSeenAt: AT('2026-09-12T09:00:00Z'),
    });

    const result = resolveStale(forgotten, AT('2026-09-14T00:00:00Z'), 16 * 3600);

    expect(result?.workedDelta).toBe(3600);
  });

  it('no toca una jornada ya cerrada', () => {
    expect(
      resolveStale(
        snapshot({ state: 'FUERA' }),
        AT('2026-09-30T00:00:00Z'),
        16 * 3600,
      ),
    ).toBeNull();
  });
});

describe('businessDateOf', () => {
  it('usa la hora local de la sede, no la del servidor', () => {
    // A las 23:00 UTC en Bogotá (UTC-5) son las 18:00 del mismo día.
    // Sin esta conversión, todo lo fichado después de las 19:00 locales
    // se imputaría al día siguiente.
    expect(
      businessDateOf(AT('2026-09-12T23:00:00Z'), 'America/Bogota'),
    ).toBe('2026-09-12');
  });

  it('un turno de noche pertenece al día en que empezó', () => {
    // El lunes a las 22:00 en Bogotá son las 03:00 UTC del martes.
    expect(
      businessDateOf(AT('2026-09-15T03:00:00Z'), 'America/Bogota'),
    ).toBe('2026-09-14');
  });

  it('funciona con sedes en otros husos', () => {
    expect(businessDateOf(AT('2026-09-12T23:00:00Z'), 'Europe/Madrid')).toBe(
      '2026-09-13',
    );
  });

  it('falla ruidosamente con una zona horaria inventada', () => {
    // Mejor romper al procesar el evento que imputar en silencio las
    // horas de una sede al día equivocado.
    expect(() => businessDateOf(AT('2026-09-12T23:00:00Z'), 'Marte/Olympus'))
      .toThrow();
  });
});
