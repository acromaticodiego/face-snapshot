import {
  evaluatePolicy,
  ruleMatches,
  toLocalTime,
} from './policy.engine';
import type { PolicyInput, ScheduleRule } from './policy.types';

/**
 * Tests del motor de autorización.
 *
 * Es el código que decide quién entra a un edificio: los casos límite
 * aquí no son teóricos. Un turno de noche mal evaluado deja a alguien
 * fuera a las tres de la mañana, y un huso horario ignorado abre las
 * puertas cinco horas antes de tiempo.
 */

const BOGOTA = 'America/Bogota';

/** L-V de 07:00 a 19:00. */
const OFFICE_HOURS: ScheduleRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 7 * 60,
  endMinute: 19 * 60,
}));

/** Turno de noche: entra a las 22:00 y sale a las 06:00 del día siguiente. */
const NIGHT_SHIFT: ScheduleRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 22 * 60,
  endMinute: 30 * 60, // 06:00 del día siguiente
}));

function buildInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    assignments: [
      { roleId: 'role-employee', validFrom: new Date('2020-01-01'), validUntil: null },
    ],
    permissions: [
      {
        roleId: 'role-employee',
        zoneId: 'zone-offices',
        scheduleId: 'sch-office',
        rules: OFFICE_HOURS,
      },
    ],
    zoneId: 'zone-offices',
    accessPointActive: true,
    zoneActive: true,
    // Miércoles 2026-09-09, 15:00 en Bogotá (UTC-5) = 20:00 UTC.
    now: new Date('2026-09-09T20:00:00Z'),
    timezone: BOGOTA,
    ...overrides,
  };
}

describe('toLocalTime', () => {
  it('convierte a la hora local de la sede, no a la del servidor', () => {
    // 2026-09-09T20:00:00Z son las 15:00 en Bogotá (UTC-5).
    const local = toLocalTime(new Date('2026-09-09T20:00:00Z'), BOGOTA);
    expect(local.weekday).toBe(3); // miércoles
    expect(local.minuteOfDay).toBe(15 * 60);
  });

  it('cambia de día de la semana al cruzar el huso', () => {
    // Jueves 02:00 UTC son todavía las 21:00 del MIERCOLES en Bogotá.
    const local = toLocalTime(new Date('2026-09-10T02:00:00Z'), BOGOTA);
    expect(local.weekday).toBe(3); // miércoles, no jueves
    expect(local.minuteOfDay).toBe(21 * 60);
  });

  it('trata la medianoche local como minuto 0', () => {
    // 05:00 UTC = 00:00 en Bogotá.
    const local = toLocalTime(new Date('2026-09-10T05:00:00Z'), BOGOTA);
    expect(local.minuteOfDay).toBe(0);
  });

  it('respeta el horario de verano de las sedes que lo aplican', () => {
    // Madrid en agosto está en UTC+2; en enero, en UTC+1.
    const summer = toLocalTime(new Date('2026-08-15T10:00:00Z'), 'Europe/Madrid');
    const winter = toLocalTime(new Date('2026-01-15T10:00:00Z'), 'Europe/Madrid');
    expect(summer.minuteOfDay).toBe(12 * 60);
    expect(winter.minuteOfDay).toBe(11 * 60);
  });

  it('falla de forma explícita ante una zona horaria inválida', () => {
    expect(() => toLocalTime(new Date(), 'No/Existe')).toThrow();
  });
});

describe('ruleMatches', () => {
  const officeMonday: ScheduleRule = {
    weekday: 1,
    startMinute: 7 * 60,
    endMinute: 19 * 60,
  };

  it('acepta un instante dentro de la franja', () => {
    expect(ruleMatches(officeMonday, 1, 12 * 60)).toBe(true);
  });

  it('acepta el minuto inicial', () => {
    expect(ruleMatches(officeMonday, 1, 7 * 60)).toBe(true);
  });

  it('rechaza el minuto final: la franja es semiabierta', () => {
    // A las 19:00 en punto ya no se puede entrar. Sin este criterio,
    // dos franjas consecutivas se solaparían un minuto.
    expect(ruleMatches(officeMonday, 1, 19 * 60)).toBe(false);
  });

  it('rechaza un minuto anterior a la franja', () => {
    expect(ruleMatches(officeMonday, 1, 6 * 60 + 59)).toBe(false);
  });

  it('rechaza el mismo horario en otro día de la semana', () => {
    expect(ruleMatches(officeMonday, 2, 12 * 60)).toBe(false);
  });

  describe('franjas que cruzan la medianoche', () => {
    const nightMonday: ScheduleRule = {
      weekday: 1,
      startMinute: 22 * 60,
      endMinute: 30 * 60, // 06:00 del martes
    };

    it('acepta el tramo del propio lunes', () => {
      expect(ruleMatches(nightMonday, 1, 23 * 60)).toBe(true);
    });

    it('acepta la madrugada del MARTES como parte del turno del lunes', () => {
      expect(ruleMatches(nightMonday, 2, 3 * 60)).toBe(true);
    });

    it('rechaza el martes una vez terminado el turno', () => {
      expect(ruleMatches(nightMonday, 2, 6 * 60)).toBe(false);
      expect(ruleMatches(nightMonday, 2, 9 * 60)).toBe(false);
    });

    it('rechaza el lunes por la mañana, antes de empezar el turno', () => {
      expect(ruleMatches(nightMonday, 1, 3 * 60)).toBe(false);
    });

    it('trata correctamente el salto de domingo a lunes', () => {
      const nightSunday: ScheduleRule = {
        weekday: 0,
        startMinute: 22 * 60,
        endMinute: 30 * 60,
      };
      // Lunes de madrugada pertenece al turno que empezó el domingo.
      expect(ruleMatches(nightSunday, 1, 2 * 60)).toBe(true);
    });
  });
});

describe('evaluatePolicy', () => {
  it('concede el acceso en horario y zona permitidos', () => {
    const result = evaluatePolicy(buildInput());
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.matchedRoleId).toBe('role-employee');
      expect(result.matchedScheduleId).toBe('sch-office');
    }
  });

  describe('estado del punto de acceso', () => {
    it('deniega si el punto está deshabilitado, sin mirar nada más', () => {
      const result = evaluatePolicy(buildInput({ accessPointActive: false }));
      expect(result).toEqual({
        allowed: false,
        reason: 'ACCESS_POINT_DISABLED',
      });
    });

    it('deniega si la zona entera está deshabilitada', () => {
      const result = evaluatePolicy(buildInput({ zoneActive: false }));
      expect(result).toEqual({
        allowed: false,
        reason: 'ACCESS_POINT_DISABLED',
      });
    });
  });

  describe('roles', () => {
    it('deniega a quien no tiene ningún rol', () => {
      const result = evaluatePolicy(buildInput({ assignments: [] }));
      expect(result).toEqual({ allowed: false, reason: 'NO_ROLE_ASSIGNED' });
    });

    it('deniega cuando la asignación ya venció', () => {
      const result = evaluatePolicy(
        buildInput({
          assignments: [
            {
              roleId: 'role-employee',
              validFrom: new Date('2020-01-01'),
              validUntil: new Date('2026-01-01'),
            },
          ],
        }),
      );
      expect(result).toEqual({ allowed: false, reason: 'ASSIGNMENT_EXPIRED' });
    });

    it('deniega cuando la asignación todavía no ha empezado', () => {
      const result = evaluatePolicy(
        buildInput({
          assignments: [
            {
              roleId: 'role-employee',
              validFrom: new Date('2030-01-01'),
              validUntil: null,
            },
          ],
        }),
      );
      expect(result).toEqual({ allowed: false, reason: 'ASSIGNMENT_EXPIRED' });
    });

    it('trata el instante exacto de vencimiento como vencido', () => {
      const now = new Date('2026-09-09T20:00:00Z');
      const result = evaluatePolicy(
        buildInput({
          now,
          assignments: [
            {
              roleId: 'role-employee',
              validFrom: new Date('2020-01-01'),
              validUntil: now,
            },
          ],
        }),
      );
      expect(result).toEqual({ allowed: false, reason: 'ASSIGNMENT_EXPIRED' });
    });

    it('ignora los roles vencidos pero acepta los vigentes', () => {
      const result = evaluatePolicy(
        buildInput({
          assignments: [
            {
              roleId: 'role-contractor',
              validFrom: new Date('2020-01-01'),
              validUntil: new Date('2026-01-01'),
            },
            {
              roleId: 'role-employee',
              validFrom: new Date('2020-01-01'),
              validUntil: null,
            },
          ],
        }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('zonas', () => {
    it('deniega el acceso a una zona sin permiso', () => {
      const result = evaluatePolicy(buildInput({ zoneId: 'zone-server-room' }));
      expect(result).toEqual({
        allowed: false,
        reason: 'NO_PERMISSION_FOR_ZONE',
      });
    });

    it('no aprovecha el permiso de un rol vencido', () => {
      const result = evaluatePolicy(
        buildInput({
          zoneId: 'zone-lab',
          assignments: [
            {
              roleId: 'role-contractor',
              validFrom: new Date('2020-01-01'),
              validUntil: new Date('2026-01-01'),
            },
          ],
          permissions: [
            {
              roleId: 'role-contractor',
              zoneId: 'zone-lab',
              scheduleId: 'sch-office',
              rules: OFFICE_HOURS,
            },
          ],
        }),
      );
      // El permiso existe, pero el rol que lo otorga ya no está vigente.
      expect(result).toEqual({ allowed: false, reason: 'ASSIGNMENT_EXPIRED' });
    });
  });

  describe('horarios', () => {
    it('deniega fuera del horario del rol', () => {
      // Miércoles 03:00 en Bogotá = 08:00 UTC.
      const result = evaluatePolicy(
        buildInput({ now: new Date('2026-09-09T08:00:00Z') }),
      );
      expect(result).toEqual({ allowed: false, reason: 'OUTSIDE_SCHEDULE' });
    });

    it('deniega el fin de semana a un horario de L-V', () => {
      // Sábado 2026-09-12, 15:00 en Bogotá.
      const result = evaluatePolicy(
        buildInput({ now: new Date('2026-09-12T20:00:00Z') }),
      );
      expect(result).toEqual({ allowed: false, reason: 'OUTSIDE_SCHEDULE' });
    });

    it('permite la madrugada a quien tiene turno de noche', () => {
      // Jueves 03:00 en Bogotá = 08:00 UTC del jueves.
      // Pertenece al turno que empezó el miércoles a las 22:00.
      const result = evaluatePolicy(
        buildInput({
          now: new Date('2026-09-10T08:00:00Z'),
          permissions: [
            {
              roleId: 'role-employee',
              zoneId: 'zone-offices',
              scheduleId: 'sch-night',
              rules: NIGHT_SHIFT,
            },
          ],
        }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('acumulación de permisos', () => {
    it('basta con que UN rol lo permita', () => {
      // Empleado (horario de oficina) + guardia (turno de noche).
      // A las 03:00 debe entrar por el segundo rol.
      const result = evaluatePolicy(
        buildInput({
          now: new Date('2026-09-10T08:00:00Z'),
          assignments: [
            { roleId: 'role-employee', validFrom: new Date('2020-01-01'), validUntil: null },
            { roleId: 'role-guard', validFrom: new Date('2020-01-01'), validUntil: null },
          ],
          permissions: [
            {
              roleId: 'role-employee',
              zoneId: 'zone-offices',
              scheduleId: 'sch-office',
              rules: OFFICE_HOURS,
            },
            {
              roleId: 'role-guard',
              zoneId: 'zone-offices',
              scheduleId: 'sch-night',
              rules: NIGHT_SHIFT,
            },
          ],
        }),
      );
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.matchedRoleId).toBe('role-guard');
    });

    it('un rol restrictivo no anula a uno permisivo', () => {
      // Un permiso con un horario vacío no debe bloquear al otro rol.
      const result = evaluatePolicy(
        buildInput({
          assignments: [
            { roleId: 'role-visitor', validFrom: new Date('2020-01-01'), validUntil: null },
            { roleId: 'role-employee', validFrom: new Date('2020-01-01'), validUntil: null },
          ],
          permissions: [
            {
              roleId: 'role-visitor',
              zoneId: 'zone-offices',
              scheduleId: 'sch-none',
              rules: [],
            },
            {
              roleId: 'role-employee',
              zoneId: 'zone-offices',
              scheduleId: 'sch-office',
              rules: OFFICE_HOURS,
            },
          ],
        }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('husos horarios entre sedes', () => {
    it('la misma hora UTC concede en una sede y deniega en otra', () => {
      // 2026-09-09T20:00:00Z:
      //   Bogotá (UTC-5) → 15:00, dentro del horario de oficina
      //   Madrid (UTC+2) → 22:00, fuera
      const bogota = evaluatePolicy(buildInput({ timezone: 'America/Bogota' }));
      const madrid = evaluatePolicy(buildInput({ timezone: 'Europe/Madrid' }));

      expect(bogota.allowed).toBe(true);
      expect(madrid).toEqual({ allowed: false, reason: 'OUTSIDE_SCHEDULE' });
    });
  });
});
