import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import type { AccessPointContext } from '../policy/policy.repository';

type AccessReason =
  | 'GRANTED'
  | 'BELOW_THRESHOLD'
  | 'NO_FACE_DETECTED'
  | 'MULTIPLE_FACES'
  | 'LOW_QUALITY'
  | 'INSUFFICIENT_VOTES'
  | 'PERSON_SUSPENDED'
  | 'NO_ROLE_ASSIGNED'
  | 'NO_PERMISSION_FOR_ZONE'
  | 'OUTSIDE_SCHEDULE'
  | 'ASSIGNMENT_EXPIRED'
  | 'ACCESS_POINT_DISABLED'
  | 'LIVENESS_FAILED'
  | 'ANTIPASSBACK_VIOLATION';

@Injectable()
export class AccessLogsService {
  private readonly logger = new Logger(AccessLogsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deja constancia de un intento de acceso.
   *
   * Nunca falla hacia arriba: si la auditoría no se puede escribir, se
   * registra el problema pero no se bloquea la respuesta al usuario. Un
   * fallo del registro no debe dejar a nadie fuera de la puerta.
   */
  async record(entry: {
    personId: string | null;
    personName: string | null;
    authenticated: boolean;
    confidence: number;
    reason: AccessReason;
    cameraId: string;
    sessionId?: string;
    /** Contexto físico del intento. */
    point?: AccessPointContext;
  }): Promise<void> {
    try {
      await this.prisma.accessLog.create({
        data: {
          personId: entry.personId,
          personName: entry.personName,
          authenticated: entry.authenticated,
          confidence: entry.confidence,
          reason: entry.reason,
          cameraId: entry.cameraId,
          sessionId: entry.sessionId ?? null,
          // Se desnormalizan los nombres además de los identificadores:
          // el asiento debe seguir diciendo por dónde se intentó entrar
          // aunque mañana se renombre o elimine la zona.
          siteId: entry.point?.siteId ?? null,
          siteName: entry.point?.siteName ?? null,
          zoneId: entry.point?.zoneId ?? null,
          zoneName: entry.point?.zoneName ?? null,
          accessPointId: entry.point?.accessPointId ?? null,
          accessPointName: entry.point?.accessPointName ?? null,
          direction: entry.point?.direction ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `No se pudo escribir el registro de acceso: ${(error as Error).message}`,
      );
    }
  }

  async findLogs(params: {
    skip?: number;
    take?: number;
    onlyGranted?: boolean;
  }) {
    const where =
      params.onlyGranted === undefined
        ? {}
        : { authenticated: params.onlyGranted };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.accessLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.skip ?? 0,
        take: Math.min(params.take ?? 50, 200),
      }),
      this.prisma.accessLog.count({ where }),
    ]);

    return { items, total };
  }
}

/** Convierte '15m', '2h', '30s' a milisegundos. */
export function parseTtlMs(ttl: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(ttl.trim());
  if (!match) return 15 * 60 * 1000;

  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * multipliers[unit];
}
