import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { resolvePause, resolveStale, type ShiftSnapshot } from './shift.machine';

/**
 * Cierra las jornadas que nadie va a cerrar.
 *
 * POR QUE HACE FALTA ALGO QUE MIRE EL RELOJ
 * ─────────────────────────────────────────
 * Todo lo demás en este servicio reacciona a un evento. Estos dos
 * casos son justo lo contrario: lo que los dispara es que NO haya
 * pasado nada.
 *
 *   · Una pausa que se alarga. Salir abre un estado provisional,
 *     porque en ese momento no se puede saber si la persona volverá.
 *     Cuando pasa el tiempo sin que vuelva, la pausa deja de ser una
 *     pausa y pasa a ser el final de la jornada —con la hora de la
 *     salida, no la de ahora—.
 *
 *   · Una jornada que lleva abierta más de lo que dura ningún turno.
 *     Es quien se fue por una puerta sin lector. Sin cerrarla, la hoja
 *     de horas acabaría mostrando jornadas de tres días y ninguna
 *     estadística significaría nada.
 *
 * Las dos decisiones son funciones puras de `shift.machine`; aquí solo
 * está la parte que consulta y escribe.
 */
@Injectable()
export class ShiftReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShiftReconciler.name);

  private readonly intervalMs: number;
  private readonly pauseTimeoutSeconds: number;
  private readonly maxShiftSeconds: number;

  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.intervalMs = Number(config.get('RECONCILER_INTERVAL_MS', 60_000));
    this.pauseTimeoutSeconds =
      Number(config.get('SHIFT_PAUSE_TIMEOUT_MINUTES', 90)) * 60;
    this.maxShiftSeconds = Number(config.get('SHIFT_MAX_HOURS', 16)) * 3600;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `Reconciliador activo: pausas de más de ${this.pauseTimeoutSeconds / 60} min ` +
        `y jornadas de más de ${this.maxShiftSeconds / 3600} h`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Una pasada. Pública para poder forzarla en las pruebas. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      // Solo se miran jornadas abiertas, que son unas pocas decenas
      // aunque la tabla tenga años de historia.
      const open = await this.prisma.workDay.findMany({
        where: { endedAt: null },
        include: {
          entries: { orderBy: { at: 'desc' }, take: 1, select: { at: true } },
        },
      });

      let closed = 0;
      for (const day of open) {
        const snapshot: ShiftSnapshot = {
          state: day.state,
          stateSince: day.stateSince,
          lastSeenAt: day.entries[0]?.at ?? day.stateSince,
          workedSeconds: day.workedSeconds,
          breakSeconds: day.breakSeconds,
        };

        // El orden importa: una pausa larga se cierra como pausa
        // -sin contar ese tiempo- antes de que la jornada llegue a
        // considerarse olvidada, que es un caso peor y menos preciso.
        const pause = resolvePause(snapshot, now, this.pauseTimeoutSeconds);
        if (pause) {
          await this.close(day.id, pause.endedAt, 'TIMEOUT', 0, 0);
          closed++;
          continue;
        }

        const stale = resolveStale(snapshot, now, this.maxShiftSeconds);
        if (stale) {
          await this.close(
            day.id,
            stale.endedAt,
            'STALE',
            stale.workedDelta,
            stale.breakDelta,
          );
          closed++;
        }
      }

      return closed;
    } catch (error) {
      this.logger.error(
        `El reconciliador no pudo completar la pasada: ${(error as Error).message}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async close(
    workDayId: string,
    endedAt: Date,
    closedBy: 'TIMEOUT' | 'STALE',
    workedDelta: number,
    breakDelta: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Se lee ANTES de actualizar: después, el estado ya sería FUERA y
      // la línea de tiempo diría que la jornada pasó de estar fuera a
      // estar fuera.
      const before = await tx.workDay.findUniqueOrThrow({
        where: { id: workDayId },
        select: { state: true, personName: true, personId: true },
      });

      await tx.workDay.update({
        where: { id: workDayId },
        data: {
          state: 'FUERA',
          stateSince: endedAt,
          endedAt,
          closedBy,
          workedSeconds: { increment: workedDelta },
          breakSeconds: { increment: breakDelta },
        },
      });

      // El cierre también es un hecho de la jornada y merece su sitio
      // en la línea de tiempo. Va sin `sourceEventId` porque no nace de
      // ningún paso por una puerta: lo genera este servicio.
      await tx.timelineEntry.create({
        data: {
          workDayId,
          personId: before.personId,
          at: endedAt,
          fromState: before.state,
          toState: 'FUERA',
        },
      });

      this.logger.log(
        `Jornada de ${before.personName} cerrada por ${closedBy} a las ` +
          endedAt.toISOString(),
      );
    });
  }
}
