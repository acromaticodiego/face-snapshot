import type {
  PolicyInput,
  PolicyResult,
  RolePermission,
  ScheduleRule,
} from './policy.types';

/**
 * Motor de autorización.
 *
 * Responde a una sola pregunta: *¿puede esta persona pasar por aquí,
 * ahora?* Es una función pura —sin base de datos, sin reloj propio,
 * sin efectos— para poder probarla exhaustivamente. Quien la llama se
 * encarga de cargar los datos y de registrar el resultado.
 *
 * ORDEN DE LAS COMPROBACIONES
 * ---------------------------
 * Va de lo más general a lo más específico, y ese orden importa: el
 * motivo que se devuelve es el que se guarda en la auditoría, y quien
 * investiga un incidente necesita el más informativo. Ante alguien sin
 * ningún rol, "no tiene rol asignado" explica mucho más que "fuera de
 * horario", aunque ambas fueran ciertas.
 */

const MINUTES_PER_DAY = 24 * 60;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Traduce un instante a la hora local de la sede.
 *
 * POR QUE NO SE USA getDay() Y getHours()
 * ---------------------------------------
 * Esos métodos usan la zona horaria del SERVIDOR. Con el backend en un
 * contenedor en UTC y una sede en Bogotá (UTC-5), un turno que termina
 * a las 19:00 locales se evaluaría contra las 00:00 del día siguiente:
 * la puerta se cerraría cinco horas antes de tiempo, y encima cambiando
 * de día de la semana.
 *
 * `Intl.DateTimeFormat` con `timeZone` hace la conversión correcta,
 * incluidos los cambios de horario de verano, sin dependencias.
 */
export function toLocalTime(
  now: Date,
  timezone: string,
): { weekday: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const lookup = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekday = WEEKDAY_INDEX[lookup('weekday')];
  if (weekday === undefined) {
    throw new Error(`Zona horaria no reconocida: ${timezone}`);
  }

  // En hour12:false, la medianoche puede llegar como "24".
  const hour = Number(lookup('hour')) % 24;
  const minute = Number(lookup('minute'));

  return { weekday, minuteOfDay: hour * 60 + minute };
}

/**
 * ¿Cae el momento actual dentro de esta franja?
 *
 * Contempla las franjas que cruzan la medianoche, que en un sistema de
 * turnos no son una rareza sino el turno de noche. Una regla de lunes
 * 22:00-06:00 cubre dos tramos:
 *
 *   · el lunes,  de 22:00 a 24:00
 *   · el martes, de 00:00 a 06:00
 *
 * El segundo tramo pertenece a la regla del LUNES aunque ocurra en
 * martes; por eso hay que mirar también la regla del día anterior.
 */
export function ruleMatches(
  rule: ScheduleRule,
  weekday: number,
  minuteOfDay: number,
): boolean {
  // Tramo del mismo día.
  if (rule.weekday === weekday) {
    const end = Math.min(rule.endMinute, MINUTES_PER_DAY);
    if (minuteOfDay >= rule.startMinute && minuteOfDay < end) return true;
  }

  // Continuación de una franja iniciada el día anterior.
  if (rule.endMinute > MINUTES_PER_DAY) {
    const previousWeekday = (weekday + 6) % 7;
    if (rule.weekday === previousWeekday) {
      if (minuteOfDay < rule.endMinute - MINUTES_PER_DAY) return true;
    }
  }

  return false;
}

function isAssignmentValid(
  assignment: { validFrom: Date; validUntil: Date | null },
  now: Date,
): boolean {
  if (assignment.validFrom > now) return false;
  if (assignment.validUntil && assignment.validUntil <= now) return false;
  return true;
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  // 1. El punto de acceso o la zona pueden estar fuera de servicio.
  //    Se comprueba primero: si la puerta está deshabilitada, no
  //    importa quién seas.
  if (!input.accessPointActive || !input.zoneActive) {
    return { allowed: false, reason: 'ACCESS_POINT_DISABLED' };
  }

  // 2. ¿Tiene algún rol?
  if (input.assignments.length === 0) {
    return { allowed: false, reason: 'NO_ROLE_ASSIGNED' };
  }

  // 3. ¿Alguno sigue vigente?
  const activeRoleIds = new Set(
    input.assignments
      .filter((assignment) => isAssignmentValid(assignment, input.now))
      .map((assignment) => assignment.roleId),
  );

  if (activeRoleIds.size === 0) {
    return { allowed: false, reason: 'ASSIGNMENT_EXPIRED' };
  }

  // 4. ¿Alguno de esos roles da acceso a ESTA zona?
  const candidates: RolePermission[] = input.permissions.filter(
    (permission) =>
      permission.zoneId === input.zoneId && activeRoleIds.has(permission.roleId),
  );

  if (candidates.length === 0) {
    return { allowed: false, reason: 'NO_PERMISSION_FOR_ZONE' };
  }

  // 5. ¿Estamos dentro del horario de alguno?
  //
  //    Los permisos se acumulan: basta con que UNO lo permita. Alguien
  //    con rol de empleado y de guardia entra en horario de oficina y
  //    también de madrugada, sin que un rol anule al otro.
  const { weekday, minuteOfDay } = toLocalTime(input.now, input.timezone);

  for (const permission of candidates) {
    for (const rule of permission.rules) {
      if (ruleMatches(rule, weekday, minuteOfDay)) {
        return {
          allowed: true,
          matchedRoleId: permission.roleId,
          matchedScheduleId: permission.scheduleId,
        };
      }
    }
  }

  return { allowed: false, reason: 'OUTSIDE_SCHEDULE' };
}
