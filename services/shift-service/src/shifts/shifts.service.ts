import { Injectable, Logger } from '@nestjs/common';

import type { Prisma } from '@prisma/client';

import type { AccessGrantedEvent } from '../consumer/access-event.parser';
import { PrismaService } from '../prisma/prisma.service';
import {
  applyPassage,
  businessDateOf,
  type ShiftSnapshot,
  type ShiftState,
} from './shift.machine';

/**
 * Proyecta los eventos de acceso sobre la jornada laboral.
 *
 * Este servicio hace E/S; la máquina de estados no. La separación es
 * la misma que en el Access Service entre `PolicyService` y
 * `policy.engine`, y por el mismo motivo: cuando una jornada sale mal
 * calculada, saber si el fallo fue de la lógica o de la escritura
 * acorta muchísimo la investigación.
 *
 * IDEMPOTENCIA
 * ────────────
 * Cada evento deja exactamente una entrada en la línea de tiempo, con
 * `sourceEventId` único. La entrega por el bus es "al menos una vez",
 * así que el mismo evento puede llegar dos veces tras un reinicio; la
 * segunda choca contra ese índice y se descarta sin haber sumado
 * horas dos veces. Es la restricción de la base de datos la que da la
 * garantía, no una comprobación previa que dos procesos podrían pasar
 * a la vez.
 */
@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async applyAccessEvent(event: AccessGrantedEvent): Promise<void> {
    const at = new Date(event.occurredAt);

    await this.prisma.$transaction(async (tx) => {
      // Comprobación temprana: evita el trabajo de recalcular una
      // jornada para un evento ya visto. No sustituye al índice único
      // —dos procesos podrían llegar aquí a la vez—, solo lo ahorra en
      // el caso frecuente.
      const seen = await tx.timelineEntry.findUnique({
        where: { sourceEventId: event.eventId },
        select: { id: true },
      });
      if (seen) {
        this.logger.debug(`Evento ${event.eventId} ya procesado; se ignora`);
        return;
      }

      const open = await tx.workDay.findFirst({
        where: { personId: event.personId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });

      const snapshot: ShiftSnapshot | null = open
        ? {
            state: open.state,
            stateSince: open.stateSince,
            lastSeenAt: await this.lastSeenAt(tx, open.id, open.stateSince),
            workedSeconds: open.workedSeconds,
            breakSeconds: open.breakSeconds,
          }
        : null;

      const decision = applyPassage(snapshot, {
        direction: event.direction,
        zoneShiftEffect: event.zoneShiftEffect,
        stillInsideSite: event.stillInsideSite,
        at,
      });

      if (decision.action === 'IGNORE') {
        this.logger.warn(
          `Evento ${event.eventId} descartado por desordenado ` +
            `(${event.occurredAt} es anterior al estado actual)`,
        );
        return;
      }

      const previousState: ShiftState = snapshot?.state ?? 'FUERA';
      let workDayId = open?.id ?? null;
      let newState = previousState;

      if (decision.action === 'OPEN') {
        newState = decision.state;
        const created = await tx.workDay.create({
          data: {
            personId: event.personId,
            personName: event.personName,
            siteId: event.siteId,
            siteName: event.siteName,
            // La fecha se fija al abrir y no se recalcula: un turno de
            // noche que empieza el lunes es la jornada del lunes.
            businessDate: new Date(
              `${businessDateOf(at, event.siteTimezone)}T00:00:00Z`,
            ),
            state: decision.state,
            stateSince: at,
            startedAt: at,
          },
        });
        workDayId = created.id;
      }

      if (decision.action === 'UPDATE' && open) {
        newState = decision.state;
        await tx.workDay.update({
          where: { id: open.id },
          data: {
            state: decision.state,
            stateSince: at,
            workedSeconds: { increment: decision.workedDelta },
            breakSeconds: { increment: decision.breakDelta },
          },
        });
      }

      // Todo paso deja rastro, cambie o no el estado: la línea de
      // tiempo es el registro de lo que ocurrió, no solo de lo que el
      // sistema decidió interpretar.
      await tx.timelineEntry.create({
        data: {
          workDayId,
          sourceEventId: event.eventId,
          personId: event.personId,
          at,
          fromState: previousState,
          toState: newState,
          direction: event.direction,
          zoneId: event.zoneId,
          zoneName: event.zoneName,
          accessPointName: event.accessPointName,
        },
      });
    });
  }

  /**
   * Instante del último movimiento registrado en la jornada.
   *
   * Se distingue de `stateSince` porque hay pasos que se anotan sin
   * cambiar el estado, y son la mejor prueba de hasta cuándo estuvo
   * alguien allí. Lo usa el cierre de jornadas olvidadas.
   */
  private async lastSeenAt(
    tx: Prisma.TransactionClient,
    workDayId: string,
    fallback: Date,
  ): Promise<Date> {
    const last = await tx.timelineEntry.findFirst({
      where: { workDayId },
      orderBy: { at: 'desc' },
      select: { at: true },
    });
    return last?.at ?? fallback;
  }
}
