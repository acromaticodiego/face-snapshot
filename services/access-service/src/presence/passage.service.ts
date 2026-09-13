import { Injectable, Logger } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';

import type { AccessGrantedEvent } from '../outbox/access-events';
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
 * el evento que alimenta la jornada laboral. Si se hicieran por
 * separado y el proceso muriese en medio, quedarían estados
 * imposibles: alguien con sesión abierta a quien el sistema cree
 * fuera, o unas horas trabajadas que no corresponden a ningún acceso.
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
    // Una lectura repetida no mueve la presencia ni genera evento: no
    // hubo un paso nuevo que contar. Se audita, y ahí acaba.
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

        // Cuenta las zonas de la sede en las que la persona sigue
        // dentro DESPUES de aplicar este paso. Es lo que permite al
        // Shift Service distinguir "salio del laboratorio" de "se fue
        // a casa" sin preguntar de vuelta. Va dentro de la transaccion
        // a proposito: leerlo fuera daria un numero de otro momento.
        const insideZones = await tx.presence.count({
          where: {
            personId: grant.personId,
            siteId: grant.point.siteId,
            inside: true,
          },
        });

        // El evento sale por la outbox y no por un XADD directo: si se
        // publicara justo despues de confirmar la transaccion, un
        // fallo del proceso entre ambas cosas perderia el paso, y un
        // paso perdido son horas que no se le computan a alguien.
        const event = buildAccessGrantedEvent(grant, insideZones > 0);
        await tx.outboxEvent.create({
          data: {
            id: event.eventId,
            type: event.type,
            aggregateId: grant.personId,
            // Se guarda completo: quien lo consuma no debe tener que
            // volver a preguntar nada.
            payload: { ...event },
            // El contexto de traza se captura AQUI porque este es el
            // unico momento en el que la peticion original sigue viva.
            // El relay publica hasta un segundo despues y en otro
            // proceso; sin esta columna, el tramo asincrono seria una
            // traza huerfana y se perderia justo lo que se quiere
            // ensenar: que el paso por la puerta y las horas
            // computadas son el mismo hecho.
            traceContext: traceparentActual(),
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

/**
 * El `traceparent` de la petición en curso, o `null` si no hay
 * telemetría activa.
 *
 * Se usa el inyector configurado en lugar de leer el span a mano para
 * que, si algún día se cambia el formato de propagación, esto siga
 * escribiendo lo que el resto del sistema sabe leer.
 */
function traceparentActual(): string | null {
  const portador: Record<string, string> = {};
  propagation.inject(context.active(), portador);
  return portador.traceparent ?? null;
}

/**
 * Construye el evento a partir de la concesión.
 *
 * Es una función aparte y pura para poder comprobar en una prueba que
 * el contrato que sale por el bus es el que se espera. Un evento mal
 * formado no rompe nada aquí: rompe en el consumidor, horas después y
 * en otro servicio.
 */
export function buildAccessGrantedEvent(
  grant: GrantedPassage,
  stillInsideSite: boolean,
): AccessGrantedEvent {
  return {
    eventId: randomUUID(),
    type: 'AccessGranted',
    occurredAt: grant.now.toISOString(),
    personId: grant.personId,
    personName: grant.personName,
    siteId: grant.point.siteId,
    siteName: grant.point.siteName,
    siteTimezone: grant.point.timezone,
    zoneId: grant.point.zoneId,
    zoneName: grant.point.zoneName,
    zoneShiftEffect: grant.point.shiftEffect,
    accessPointId: grant.point.accessPointId,
    accessPointName: grant.point.accessPointName,
    direction: grant.direction,
    stillInsideSite,
    // `DUPLICATE_PASSAGE` no llega hasta aquí: esa lectura no genera
    // evento. La única anomalía que un consumidor puede ver es la del
    // anti-passback blando, y le importa porque significa que la
    // presencia venía descuadrada.
    anomaly: grant.anomaly === 'ANTIPASSBACK_SOFT' ? 'ANTIPASSBACK_SOFT' : null,
  };
}
