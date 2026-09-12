import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AccessPointContext } from '../policy/policy.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  evaluateAntipassback,
  type AntipassbackResult,
  type PresenceSnapshot,
} from './antipassback.engine';

/**
 * Orquesta el anti-passback: carga la presencia y llama al motor.
 *
 * Misma separación que en la política de acceso: este servicio hace
 * E/S y puede fallar por base de datos; el motor no falla nunca porque
 * no habla con nadie. Cuando algo va mal en producción, saber en cuál
 * de las dos capas ocurrió acorta mucho la investigación.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.graceMs =
      Number(config.get('ANTIPASSBACK_GRACE_SECONDS', 10)) * 1000;
  }

  /**
   * ¿Es coherente este paso con dónde está la persona?
   *
   * Cuesta una lectura por clave primaria en cada frame. Es el precio
   * de decidir con el estado real y no con una copia que puede ir
   * retrasada; en un sistema que ya consulta roles y permisos por
   * frame, una búsqueda más por índice primario no mueve la aguja.
   */
  async evaluate(
    personId: string,
    point: AccessPointContext,
    now = new Date(),
  ): Promise<AntipassbackResult> {
    const snapshot = await this.find(personId, point.zoneId);

    const result = evaluateAntipassback({
      pointDirection: point.direction,
      accessPointId: point.accessPointId,
      mode: point.antipassbackMode,
      presence: snapshot,
      now,
      graceMs: this.graceMs,
    });

    if (result.outcome === 'DENY') {
      this.logger.log(
        `Anti-passback en ${point.siteName}/${point.zoneName}: ya consta dentro`,
      );
    }

    return result;
  }

  private async find(
    personId: string,
    zoneId: string,
  ): Promise<PresenceSnapshot | null> {
    const row = await this.prisma.presence.findUnique({
      where: { personId_zoneId: { personId, zoneId } },
      select: {
        inside: true,
        lastPassageAt: true,
        lastAccessPointId: true,
        lastDirection: true,
      },
    });

    if (!row) return null;

    // `lastDirection` es un `PassageDirection`, que admite BOTH; la
    // presencia solo se escribe con sentidos resueltos, así que un BOTH
    // aquí solo puede venir de una fila manipulada a mano. Se
    // interpreta por el estado, que es el dato fiable.
    const lastDirection =
      row.lastDirection === 'BOTH'
        ? row.inside
          ? 'IN'
          : 'OUT'
        : row.lastDirection;

    return { ...row, lastDirection };
  }

  /** Quién está dentro ahora mismo, para el panel de operación. */
  async listInside(params: { siteId?: string; zoneId?: string }) {
    return this.prisma.presence.findMany({
      where: {
        inside: true,
        ...(params.siteId ? { siteId: params.siteId } : {}),
        ...(params.zoneId ? { zoneId: params.zoneId } : {}),
      },
      orderBy: { lastPassageAt: 'desc' },
    });
  }
}
