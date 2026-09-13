import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Resumen de lo que registraron las puertas en una franja horaria.
 *
 * PARA QUE EXISTE
 * ───────────────
 * Lo consume el Logbook Service al firmar un parte de relevo, para
 * congelarlo dentro. Un vigilante cuenta lo que recuerda; las puertas
 * registran lo que pasó. Las dos cosas juntas valen más que cualquiera
 * por separado: un parte que dice "noche tranquila" junto a catorce
 * denegaciones en el muelle es una conversación pendiente.
 *
 * POR QUE UN RESUMEN Y NO LAS FILAS
 * ─────────────────────────────────
 * Un turno de ocho horas en una oficina con tráfico deja miles de
 * asientos. Mandarlos todos para guardarlos dentro de un parte
 * hincharía la bitácora con una copia de la auditoría, que ya existe y
 * es la autoridad sobre esos hechos. Lo que el parte necesita es el
 * recuento y lo ANORMAL: las denegaciones y las anomalías.
 *
 * LOS ASIENTOS CONCEDIDOS NO SE LISTAN, SOLO SE CUENTAN
 * ─────────────────────────────────────────────────────
 * Y no es solo por tamaño. Un parte de relevo lo lee después quien
 * entra al turno siguiente, que no tiene por qué ver el ir y venir
 * nominal de sus compañeros durante ocho horas. Lo que sí necesita ver
 * es lo que no cuadró.
 */
@Injectable()
export class WindowSummaryService {
  private readonly logger = new Logger(WindowSummaryService.name);

  /** Tope de sucesos anormales que se listan uno a uno. */
  private static readonly MAX_NOTABLES = 50;

  constructor(private readonly prisma: PrismaService) {}

  async summarize(params: { from: Date; to: Date; siteId?: string }) {
    const where = {
      createdAt: { gte: params.from, lte: params.to },
      ...(params.siteId ? { siteId: params.siteId } : {}),
    };

    const [site, porMotivo, anomalias, notables] = await Promise.all([
      params.siteId ? this.site(params.siteId) : Promise.resolve(null),

      // Agrupar en SQL y no traer filas para contarlas en memoria: es
      // el mismo criterio que ya sigue el panel de operación.
      this.prisma.accessLog.groupBy({
        by: ['reason'],
        where,
        _count: { _all: true },
      }),

      this.prisma.accessLog.groupBy({
        by: ['anomaly'],
        where: { ...where, anomaly: { not: null } },
        _count: { _all: true },
      }),

      this.prisma.accessLog.findMany({
        where: {
          ...where,
          // Lo anormal: o no se concedió, o se concedió con algo raro.
          OR: [{ authenticated: false }, { anomaly: { not: null } }],
        },
        orderBy: { createdAt: 'asc' },
        take: WindowSummaryService.MAX_NOTABLES,
        select: {
          id: true,
          createdAt: true,
          personName: true,
          authenticated: true,
          reason: true,
          anomaly: true,
          zoneName: true,
          accessPointName: true,
          direction: true,
        },
      }),
    ]);

    const total = porMotivo.reduce((suma, fila) => suma + fila._count._all, 0);
    const concedidos =
      porMotivo.find((fila) => fila.reason === 'GRANTED')?._count._all ?? 0;

    return {
      site,
      window: { from: params.from.toISOString(), to: params.to.toISOString() },
      totals: {
        attempts: total,
        granted: concedidos,
        denied: total - concedidos,
      },
      byReason: porMotivo
        .filter((fila) => fila.reason !== 'GRANTED')
        .map((fila) => ({ reason: fila.reason, count: fila._count._all }))
        .sort((a, b) => b.count - a.count),
      anomalies: anomalias.map((fila) => ({
        anomaly: fila.anomaly,
        count: fila._count._all,
      })),
      // Se dice si la lista se cortó. Un parte que solo enseñara los
      // primeros cincuenta sucesos sin avisar daría a entender que no
      // hubo más, que es peor que no enseñar ninguno.
      notable: notables,
      notableTruncated: notables.length === WindowSummaryService.MAX_NOTABLES,
    };
  }

  /**
   * Datos de la sede, incluida su zona horaria.
   *
   * Viajan en esta misma respuesta a propósito. Quien firma un parte
   * necesita saber a qué día LOCAL imputarlo, y preguntarlo en una
   * segunda llamada sería una ida y vuelta más por un dato que ya se
   * está yendo a buscar aquí.
   */
  private async site(siteId: string) {
    try {
      return await this.prisma.site.findUnique({
        where: { id: siteId },
        select: { id: true, name: true, timezone: true },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la sede ${siteId}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
