import { Injectable, Logger } from '@nestjs/common';

import type { AccessPointContext } from '../policy/policy.repository';
import { PrismaService } from '../prisma/prisma.service';
import type { Passage } from './antipassback.engine';

/**
 * Registra una concesión de acceso.
 *
 * TODO OCURRE EN UNA SOLA TRANSACCION
 * ───────────────────────────────────
 * Conceder el acceso son cuatro escrituras que solo tienen sentido
 * juntas: la sesión emitida, el asiento de auditoría, la presencia y
 * —desde el commit siguiente— el evento que alimenta la jornada
 * laboral. Si se hicieran por separado y el proceso muriese en medio,
 * quedarían estados imposibles: alguien con sesión abierta que el
 * sistema cree fuera, o unas horas trabajadas que no corresponden a
 * ningún acceso.
 *
 * POR QUE ESTA ESCRITURA SI PUEDE TUMBAR LA CONCESION
 * ──────────────────────────────────────────────────
 * `AccessLogsService.record` está escrito para no fallar nunca hacia
 * arriba: un fallo del registro no debe dejar a nadie fuera. Aquí la
 * regla se invierte a propósito, y la asimetría es deliberada:
 *
 *   · No poder registrar una DENEGACION es molesto, pero no crea un
 *     estado incoherente: la puerta sigue cerrada.
 *   · No poder registrar una CONCESION sí lo crea: la persona pasa y
 *     el sistema la sigue creyendo fuera, con lo que su siguiente
 *     salida será una violación y sus horas no cuadrarán.
 *
 * Y no añade una dependencia nueva: la política ya consulta la base de
 * datos en cada frame, así que sin base de datos no se concedía nada
 * antes de este cambio tampoco.
 */

export interface GrantedPassage {
  personId: string;
  personName: string;
  confidence: number;
  cameraId: string;
  point: AccessPointContext;
  direction: Passage;
  /**
   * Anomalía que acompaña a la concesión, si la hubo.
   *
   * `DUPLICATE_PASSAGE` implica además que la presencia NO se mueve:
   * la lectura es un eco de un paso ya registrado.
   */
  anomaly: 'ANTIPASSBACK_SOFT' | 'DUPLICATE_PASSAGE' | null;
  sessionTtlMs: number;
  now: Date;
}

@Injectable()
export class PassageService {
  private readonly logger = new Logger(PassageService.name);

  constructor(private readonly prisma: PrismaService) {}

  async registerGrant(
    grant: GrantedPassage,
  ): Promise<{ sessionId: string; expiresAt: Date }> {
    const movesPresence = grant.anomaly !== 'DUPLICATE_PASSAGE';

    return this.prisma.$transaction(async (tx) => {
      const session = await tx.accessSession.create({
        data: {
          personId: grant.personId,
          personName: grant.personName,
          expiresAt: new Date(grant.now.getTime() + grant.sessionTtlMs),
        },
      });

      await tx.accessLog.create({
        data: {
          personId: grant.personId,
          personName: grant.personName,
          authenticated: true,
          confidence: grant.confidence,
          reason: 'GRANTED',
          anomaly: grant.anomaly,
          cameraId: grant.cameraId,
          sessionId: session.id,
          siteId: grant.point.siteId,
          siteName: grant.point.siteName,
          zoneId: grant.point.zoneId,
          zoneName: grant.point.zoneName,
          accessPointId: grant.point.accessPointId,
          accessPointName: grant.point.accessPointName,
          // El sentido RESUELTO, no el configurado: un asiento que dice
          // "BOTH" no responde a la pregunta de si aquella persona
          // entró o salió.
          direction: grant.direction,
        },
      });

      if (movesPresence) {
        await tx.presence.upsert({
          where: {
            personId_zoneId: {
              personId: grant.personId,
              zoneId: grant.point.zoneId,
            },
          },
          create: {
            personId: grant.personId,
            zoneId: grant.point.zoneId,
            siteId: grant.point.siteId,
            inside: grant.direction === 'IN',
            lastDirection: grant.direction,
            lastAccessPointId: grant.point.accessPointId,
            lastPassageAt: grant.now,
          },
          update: {
            siteId: grant.point.siteId,
            inside: grant.direction === 'IN',
            lastDirection: grant.direction,
            lastAccessPointId: grant.point.accessPointId,
            lastPassageAt: grant.now,
          },
        });
      }

      if (grant.anomaly) {
        this.logger.warn(
          `${grant.anomaly} de ${grant.personName} en ` +
            `${grant.point.siteName}/${grant.point.zoneName}`,
        );
      }

      return { sessionId: session.id, expiresAt: session.expiresAt };
    });
  }
}
