import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { PersonRoleAssignment, RolePermission } from './policy.types';

export interface AccessPointContext {
  accessPointId: string;
  accessPointName: string;
  accessPointActive: boolean;
  direction: 'IN' | 'OUT' | 'BOTH';
  zoneId: string;
  zoneName: string;
  zoneActive: boolean;
  /** Como trata esta zona el intento de entrar sin haber salido. */
  antipassbackMode: 'HARD' | 'SOFT' | 'OFF';
  /**
   * Si el tiempo pasado aqui cuenta como jornada.
   *
   * Viaja con el contexto para que el evento de acceso lo lleve
   * denormalizado: asi el Shift Service interpreta un paso sin tener
   * que preguntar a este servicio, que es lo que lo mantiene fuera del
   * camino critico.
   */
  shiftEffect: 'WORK' | 'BREAK' | 'NEUTRAL';
  siteId: string;
  siteName: string;
  timezone: string;
}

/**
 * Carga los datos que necesita el motor de autorización.
 *
 * Está separado del motor a propósito: el motor es una función pura y
 * no debe saber que existe una base de datos. Así puede probarse sin
 * contenedores y este repositorio puede optimizarse (caché, por
 * ejemplo) sin tocar la lógica de decisión.
 */
@Injectable()
export class PolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resuelve el terminal físico que envía la petición.
   *
   * Devuelve `null` si la clave no existe: un terminal desconocido no
   * debe poder provocar accesos, ni siquiera con un rostro válido.
   */
  async findAccessPointByTerminalKey(
    terminalKey: string,
  ): Promise<AccessPointContext | null> {
    const point = await this.prisma.accessPoint.findUnique({
      where: { terminalKey },
      include: { zone: { include: { site: true } } },
    });

    if (!point) return null;

    return {
      accessPointId: point.id,
      accessPointName: point.name,
      accessPointActive: point.isActive,
      direction: point.direction,
      zoneId: point.zone.id,
      zoneName: point.zone.name,
      zoneActive: point.zone.isActive && point.zone.site.isActive,
      antipassbackMode: point.zone.antipassbackMode,
      shiftEffect: point.zone.shiftEffect,
      siteId: point.zone.site.id,
      siteName: point.zone.site.name,
      timezone: point.zone.site.timezone,
    };
  }

  /** Roles vigentes o no de una persona. El motor decide la vigencia. */
  async findAssignments(personId: string): Promise<PersonRoleAssignment[]> {
    const rows = await this.prisma.personRole.findMany({
      where: { personId, role: { isActive: true } },
      select: { roleId: true, validFrom: true, validUntil: true },
    });
    return rows;
  }

  /**
   * Permisos de una zona para los roles indicados.
   *
   * Se filtra por zona en la consulta y no en memoria: una empresa con
   * decenas de zonas y roles generaría cientos de permisos que no
   * tienen nada que ver con la puerta por la que se está pasando.
   */
  async findPermissions(
    roleIds: string[],
    zoneId: string,
  ): Promise<RolePermission[]> {
    if (roleIds.length === 0) return [];

    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId: { in: roleIds }, zoneId },
      include: {
        schedule: {
          include: {
            rules: {
              select: { weekday: true, startMinute: true, endMinute: true },
            },
          },
        },
      },
    });

    return rows.map((row) => ({
      roleId: row.roleId,
      zoneId: row.zoneId,
      scheduleId: row.scheduleId,
      rules: row.schedule.rules,
    }));
  }
}
