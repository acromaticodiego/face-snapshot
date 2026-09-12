import {
  evaluateAntipassback,
  resolveDirection,
  type AntipassbackInput,
  type PresenceSnapshot,
} from './antipassback.engine';

/**
 * El anti-passback decide si una puerta se abre, así que se prueba con
 * el mismo nivel de detalle que el motor de política: cada rama, cada
 * modo y cada frontera temporal.
 */

const DOOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_DOOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-09-12T14:00:00.000Z');

function presence(
  overrides: Partial<PresenceSnapshot> = {},
): PresenceSnapshot {
  return {
    inside: true,
    lastPassageAt: new Date('2026-09-12T08:00:00.000Z'),
    lastAccessPointId: DOOR,
    lastDirection: 'IN',
    ...overrides,
  };
}

function input(overrides: Partial<AntipassbackInput> = {}): AntipassbackInput {
  return {
    pointDirection: 'BOTH',
    accessPointId: DOOR,
    mode: 'SOFT',
    presence: null,
    now: NOW,
    graceMs: 10_000,
    ...overrides,
  };
}

describe('resolveDirection', () => {
  it('respeta el sentido configurado en una puerta de un solo sentido', () => {
    expect(resolveDirection('IN', presence({ inside: true }))).toBe('IN');
    expect(resolveDirection('OUT', presence({ inside: false }))).toBe('OUT');
  });

  it('en un punto bidireccional, quien está fuera entra', () => {
    expect(resolveDirection('BOTH', presence({ inside: false }))).toBe('IN');
  });

  it('en un punto bidireccional, quien está dentro sale', () => {
    expect(resolveDirection('BOTH', presence({ inside: true }))).toBe('OUT');
  });

  it('sin presencia previa, el primer paso siempre es una entrada', () => {
    expect(resolveDirection('BOTH', null)).toBe('IN');
  });
});

describe('evaluateAntipassback · paso normal', () => {
  it('deja entrar a quien nunca ha pasado', () => {
    expect(evaluateAntipassback(input())).toEqual({
      outcome: 'ALLOW',
      direction: 'IN',
    });
  });

  it('deja salir por un torniquete a quien está dentro', () => {
    const result = evaluateAntipassback(
      input({ presence: presence({ inside: true }) }),
    );

    expect(result).toEqual({ outcome: 'ALLOW', direction: 'OUT' });
  });

  it('deja entrar por una puerta de entrada a quien está fuera', () => {
    const result = evaluateAntipassback(
      input({
        pointDirection: 'IN',
        presence: presence({ inside: false, lastDirection: 'OUT' }),
      }),
    );

    expect(result).toEqual({ outcome: 'ALLOW', direction: 'IN' });
  });

  it('un punto bidireccional nunca produce una incoherencia', () => {
    // Su sentido se deduce del estado, así que por construcción siempre
    // es coherente. Lo comprobamos en los dos estados posibles.
    for (const inside of [true, false]) {
      const result = evaluateAntipassback(
        input({ mode: 'HARD', presence: presence({ inside }) }),
      );
      expect(result.outcome).toBe('ALLOW');
    }
  });
});

describe('evaluateAntipassback · violación', () => {
  const enteringWhileInside = input({
    pointDirection: 'IN',
    presence: presence({ inside: true }),
  });

  it('deniega la entrada de quien ya está dentro, en modo estricto', () => {
    const result = evaluateAntipassback({
      ...enteringWhileInside,
      mode: 'HARD',
    });

    expect(result).toEqual({ outcome: 'DENY', direction: 'IN' });
  });

  it('en modo blando concede y marca la anomalía', () => {
    const result = evaluateAntipassback({
      ...enteringWhileInside,
      mode: 'SOFT',
    });

    expect(result).toEqual({ outcome: 'ALLOW_SOFT', direction: 'IN' });
  });

  it('en modo apagado no comprueba nada', () => {
    const result = evaluateAntipassback({
      ...enteringWhileInside,
      mode: 'OFF',
    });

    expect(result).toEqual({ outcome: 'ALLOW', direction: 'IN' });
  });

  it('salir sin constar dentro también es una incoherencia', () => {
    const result = evaluateAntipassback(
      input({
        pointDirection: 'OUT',
        mode: 'HARD',
        presence: presence({ inside: false, lastDirection: 'OUT' }),
      }),
    );

    expect(result).toEqual({ outcome: 'DENY', direction: 'OUT' });
  });

  it('la primera salida de alguien sin presencia previa es una incoherencia', () => {
    // Caso real del estreno del sistema: nadie ha "entrado" todavía,
    // así que la primera salida por una puerta de salida no cuadra. Con
    // el modo blando por defecto se corrige sola en vez de dejar a la
    // gente encerrada.
    const result = evaluateAntipassback(
      input({ pointDirection: 'OUT', presence: null }),
    );

    expect(result).toEqual({ outcome: 'ALLOW_SOFT', direction: 'OUT' });
  });
});

describe('evaluateAntipassback · ventana de gracia', () => {
  it('una segunda lectura en la misma puerta no es un paso nuevo', () => {
    const result = evaluateAntipassback(
      input({
        presence: presence({
          inside: true,
          lastDirection: 'IN',
          lastPassageAt: new Date(NOW.getTime() - 3_000),
        }),
      }),
    );

    expect(result).toEqual({ outcome: 'ALLOW_REPEAT', direction: 'IN' });
  });

  it('devuelve el sentido del paso original, no el que tocaría ahora', () => {
    // Sin esto, quedarse delante de un torniquete bidireccional haría
    // entrar y salir a la misma persona en bucle: el primer paso la
    // pone dentro, y la lectura siguiente deduciría "sale".
    const result = evaluateAntipassback(
      input({
        pointDirection: 'BOTH',
        presence: presence({
          inside: true,
          lastDirection: 'IN',
          lastPassageAt: new Date(NOW.getTime() - 1_000),
        }),
      }),
    );

    expect(result.direction).toBe('IN');
  });

  it('pasada la ventana, la lectura vuelve a ser un paso', () => {
    const result = evaluateAntipassback(
      input({
        presence: presence({
          inside: true,
          lastPassageAt: new Date(NOW.getTime() - 10_001),
        }),
      }),
    );

    expect(result).toEqual({ outcome: 'ALLOW', direction: 'OUT' });
  });

  it('el borde exacto de la ventana todavía cuenta como repetición', () => {
    const result = evaluateAntipassback(
      input({
        presence: presence({
          inside: true,
          lastPassageAt: new Date(NOW.getTime() - 10_000),
        }),
      }),
    );

    expect(result.outcome).toBe('ALLOW_REPEAT');
  });

  it('la gracia es por puerta: otra puerta sí es un paso nuevo', () => {
    // Pasar por la puerta del laboratorio dos segundos después de la
    // entrada principal es un movimiento real y debe registrarse.
    const result = evaluateAntipassback(
      input({
        accessPointId: OTHER_DOOR,
        presence: presence({
          inside: true,
          lastAccessPointId: DOOR,
          lastPassageAt: new Date(NOW.getTime() - 2_000),
        }),
      }),
    );

    expect(result).toEqual({ outcome: 'ALLOW', direction: 'OUT' });
  });

  it('la repetición gana incluso en modo estricto', () => {
    // Es la garantía de que la ventana de gracia no puede convertirse
    // en una forma de quedarse fuera por insistir.
    const result = evaluateAntipassback(
      input({
        pointDirection: 'IN',
        mode: 'HARD',
        presence: presence({
          inside: true,
          lastPassageAt: new Date(NOW.getTime() - 500),
        }),
      }),
    );

    expect(result.outcome).toBe('ALLOW_REPEAT');
  });
});
