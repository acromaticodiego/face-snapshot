import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { ShiftState } from './shift.machine';

/**
 * Lecturas de la jornada.
 *
 * Separado de `ShiftsService`, que es quien escribe. La proyección se
 * escribe por eventos y se lee por HTTP; mezclar las dos caras en una
 * clase hace que cada consulta nueva del panel acabe tocando el código
 * que calcula las horas de la gente.
 */

export interface ShiftSummary {
  state: ShiftState;
  since: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  workedSeconds: number;
  breakSeconds: number;
  /**
   * Sede de la jornada abierta. Nulo cuando no hay ninguna.
   *
   * Viaja ademas del nombre porque quien firma un parte de relevo
   * tiene que decir a que sede corresponde, y el frontend no lo sabe
   * por ningun otro camino: el terminal conoce su puerta, no su sede.
   */
  siteId: string | null;
  siteName: string | null;
}

@Injectable()
export class ShiftsQuery {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cómo va la jornada de una persona ahora mismo.
   *
   * El tiempo acumulado se completa con el tramo en curso: la columna
   * solo se actualiza en las transiciones, así que sin este ajuste
   * alguien que lleva tres horas seguidas trabajando vería cero.
   */
  async current(personId: string, now = new Date()): Promise<ShiftSummary> {
    const day = await this.prisma.workDay.findFirst({
      where: { personId, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });

    if (!day) {
      return {
        state: 'FUERA',
        since: null,
        startedAt: null,
        endedAt: null,
        workedSeconds: 0,
        breakSeconds: 0,
        siteId: null,
        siteName: null,
      };
    }

    const inProgress = Math.max(
      0,
      Math.floor((now.getTime() - day.stateSince.getTime()) / 1000),
    );

    return {
      state: day.state,
      since: day.stateSince,
      startedAt: day.startedAt,
      endedAt: null,
      workedSeconds:
        day.workedSeconds + (day.state === 'EN_TURNO' ? inProgress : 0),
      breakSeconds:
        day.breakSeconds +
        (day.state === 'EN_DESCANSO' || day.state === 'EN_PAUSA'
          ? inProgress
          : 0),
      siteId: day.siteId,
      siteName: day.siteName,
    };
  }

  /**
   * La línea de tiempo de una jornada.
   *
   * Por defecto la del día en curso; con `date`, la de un día
   * concreto. Se devuelven los hechos tal como se registraron, sin
   * recalcular nada: si mañana cambian las reglas de qué cuenta como
   * descanso, lo de ayer debe seguir contándose como se contó ayer.
   */
  async timeline(personId: string, date?: string) {
    const days = await this.prisma.workDay.findMany({
      where: {
        personId,
        ...(date ? { businessDate: new Date(`${date}T00:00:00Z`) } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: date ? 5 : 1,
      include: { entries: { orderBy: { at: 'asc' } } },
    });

    return {
      items: days.map((day) => ({
        id: day.id,
        businessDate: day.businessDate,
        state: day.state,
        startedAt: day.startedAt,
        endedAt: day.endedAt,
        closedBy: day.closedBy,
        workedSeconds: day.workedSeconds,
        breakSeconds: day.breakSeconds,
        siteName: day.siteName,
        entries: day.entries.map((entry) => ({
          at: entry.at,
          fromState: entry.fromState,
          toState: entry.toState,
          direction: entry.direction,
          zoneName: entry.zoneName,
          accessPointName: entry.accessPointName,
          // Quién provocó la transición y por qué. Sin esto, la línea
          // de tiempo no distingue un descanso que declaró la persona
          // de uno deducido de un paso por la cafetería, que es
          // justamente lo que hay que ver al revisar una jornada rara.
          origin: entry.origin,
          note: entry.note,
        })),
      })),
    };
  }

  /** Quién tiene jornada abierta ahora mismo, para el panel. */
  async openShifts(params: { siteId?: string; state?: ShiftState }) {
    const days = await this.prisma.workDay.findMany({
      where: {
        endedAt: null,
        ...(params.siteId ? { siteId: params.siteId } : {}),
        ...(params.state ? { state: params.state } : {}),
      },
      orderBy: { startedAt: 'asc' },
    });

    return {
      items: days.map((day) => ({
        personId: day.personId,
        personName: day.personName,
        state: day.state,
        since: day.stateSince,
        startedAt: day.startedAt,
        siteName: day.siteName,
      })),
      // Desglose por estado: es lo que pinta el panel de operación sin
      // tener que contar en el navegador.
      countsByState: days.reduce<Record<string, number>>((counts, day) => {
        counts[day.state] = (counts[day.state] ?? 0) + 1;
        return counts;
      }, {}),
    };
  }
}
