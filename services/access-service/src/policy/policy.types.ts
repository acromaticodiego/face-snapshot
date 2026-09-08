/**
 * Tipos del motor de autorización.
 *
 * Se declaran aparte del cliente de Prisma a propósito: el motor es
 * lógica pura, sin base de datos, y debe poder probarse construyendo
 * los datos a mano. Si dependiera de los tipos generados por Prisma,
 * cada test tendría que fabricar entidades completas.
 */

/** Franja horaria de un día de la semana, en hora local de la sede. */
export interface ScheduleRule {
  /** 0 = domingo … 6 = sábado. Mismo criterio que `Date.getDay()`. */
  weekday: number;
  /** Minutos desde medianoche. */
  startMinute: number;
  /**
   * Minutos desde medianoche. Puede superar 1440 para expresar una
   * franja que cruza la medianoche: un turno de 22:00 a 06:00 es
   * `startMinute: 1320, endMinute: 1800`.
   */
  endMinute: number;
}

export interface RolePermission {
  roleId: string;
  zoneId: string;
  scheduleId: string;
  rules: ScheduleRule[];
}

export interface PersonRoleAssignment {
  roleId: string;
  validFrom: Date;
  /** `null` = sin fecha de fin. */
  validUntil: Date | null;
}

export interface PolicyInput {
  /** Roles asignados a la persona, con su vigencia. */
  assignments: PersonRoleAssignment[];
  /** Permisos de esos roles. */
  permissions: RolePermission[];
  /** Zona a la que se pretende acceder. */
  zoneId: string;
  accessPointActive: boolean;
  zoneActive: boolean;
  /** Instante del intento. */
  now: Date;
  /** Zona horaria IANA de la sede, p.ej. `America/Bogota`. */
  timezone: string;
}

export type PolicyDenialReason =
  | 'NO_ROLE_ASSIGNED'
  | 'ASSIGNMENT_EXPIRED'
  | 'NO_PERMISSION_FOR_ZONE'
  | 'OUTSIDE_SCHEDULE'
  | 'ACCESS_POINT_DISABLED';

export type PolicyResult =
  | { allowed: true; matchedRoleId: string; matchedScheduleId: string }
  | { allowed: false; reason: PolicyDenialReason };
