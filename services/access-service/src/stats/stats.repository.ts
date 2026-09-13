import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { CloudStats } from './threshold.analysis';

/** Un tramo del histograma de similitudes. */
export interface SimilarityBucket {
  /** Extremo inferior del intervalo. */
  from: number;
  /** Extremo superior, excluido. */
  to: number;
  count: number;
}

/**
 * Consultas agregadas sobre la auditoría de accesos.
 *
 * TODO SE AGREGA EN SQL, NO EN EL NAVEGADOR
 * ─────────────────────────────────────────
 * Un histograma sobre meses de accesos son cientos de miles de filas.
 * Mandarlas al cliente para que las cuente allí sería tirar megabytes
 * por la red y colgar el panel; PostgreSQL agrupa eso sin despeinarse y
 * devuelve dos docenas de números.
 *
 * Son consultas crudas y no de Prisma porque `width_bucket` y las
 * conversiones de zona horaria no tienen equivalente en el cliente
 * tipado. Van todas parametrizadas.
 */

/** Límites del histograma de similitudes. */
const SIMILARITY_MIN = -0.2;
const SIMILARITY_MAX = 1.0;
const SIMILARITY_BUCKETS = 24;

export interface DenialCount {
  reason: string;
  count: number;
}

export interface HourlyCell {
  weekday: number;
  hour: number;
  total: number;
  granted: number;
}

@Injectable()
export class StatsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Zona horaria en la que interpretar las horas.
   *
   * Los accesos se guardan en UTC, pero un mapa de calor por hora solo
   * significa algo en la hora LOCAL de la sede: con el servidor en UTC
   * y la sede en Bogotá, el pico de entrada de las 08:00 aparecería a
   * las 13:00. Es el mismo razonamiento que el motor de horarios.
   */
  async resolveTimezone(siteId?: string): Promise<string> {
    const site = siteId
      ? await this.prisma.site.findUnique({
          where: { id: siteId },
          select: { timezone: true },
        })
      : await this.prisma.site.findFirst({
          where: { isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { timezone: true },
        });

    return site?.timezone ?? 'UTC';
  }

  /** Denegaciones agrupadas por motivo. */
  async denialsByReason(since: Date, siteId?: string): Promise<DenialCount[]> {
    const rows = await this.prisma.accessLog.groupBy({
      by: ['reason'],
      where: {
        createdAt: { gte: since },
        authenticated: false,
        ...(siteId ? { siteId } : {}),
      },
      _count: { _all: true },
      orderBy: { _count: { reason: 'desc' } },
    });

    return rows.map((row) => ({
      reason: row.reason,
      count: row._count._all,
    }));
  }

  /** Concesiones y anomalías del periodo, para dar contexto al total. */
  async summary(since: Date, siteId?: string) {
    const where = {
      createdAt: { gte: since },
      ...(siteId ? { siteId } : {}),
    };

    const [granted, denied, anomalies] = await this.prisma.$transaction([
      this.prisma.accessLog.count({
        where: { ...where, authenticated: true },
      }),
      this.prisma.accessLog.count({
        where: { ...where, authenticated: false },
      }),
      this.prisma.accessLog.count({
        where: { ...where, anomaly: { not: null } },
      }),
    ]);

    return { granted, denied, anomalies };
  }

  /**
   * Histograma de similitudes, separado en dos nubes.
   *
   * QUE CUENTA COMO CADA NUBE
   * ─────────────────────────
   * · Reconocidos: el intento se asoció a una persona (`person_id` no
   *   nulo). Incluye los denegados por permisos, y debe incluirlos: el
   *   sistema SI acertó la identidad, que es lo que mide este gráfico.
   * · Desconocidos: `BELOW_THRESHOLD`, donde la similitud guardada es
   *   la mejor obtenida contra toda la base y nadie la superó.
   *
   * Lo demás se excluye a propósito: en un `MULTIPLE_FACES` o en un
   * terminal deshabilitado la similitud vale cero porque nunca se llegó
   * a comparar nada, y meter esos ceros inventaría una montaña de
   * desconocidos que no existe.
   */
  async similarityHistogram(
    since: Date,
    siteId?: string,
  ): Promise<{
    recognized: SimilarityBucket[];
    unrecognized: SimilarityBucket[];
    recognizedStats: CloudStats;
    unrecognizedStats: CloudStats;
  }> {
    const siteFilter = siteId
      ? Prisma.sql`AND site_id = ${siteId}::uuid`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ cloud: string; bucket: number; count: bigint }>
    >`
      SELECT
        CASE WHEN person_id IS NOT NULL THEN 'recognized'
             ELSE 'unrecognized' END AS cloud,
        width_bucket(
          confidence::double precision,
          ${SIMILARITY_MIN}::double precision,
          ${SIMILARITY_MAX}::double precision,
          ${SIMILARITY_BUCKETS}
        ) AS bucket,
        count(*) AS count
      FROM access_svc.access_logs
      WHERE created_at >= ${since}
        AND (person_id IS NOT NULL OR reason = 'BELOW_THRESHOLD')
        ${siteFilter}
      GROUP BY 1, 2
    `;

    // Los extremos se piden aparte y SIN agrupar. Los intervalos del
    // histograma miden 0.05, y el margen que interesa vigilar es de
    // centesimas: leerlo de los intervalos redondearia justo el numero
    // que hay que mirar con lupa.
    const extremes = await this.prisma.$queryRaw<
      Array<{ cloud: string; samples: bigint; min: number; max: number }>
    >`
      SELECT
        CASE WHEN person_id IS NOT NULL THEN 'recognized'
             ELSE 'unrecognized' END AS cloud,
        count(*) AS samples,
        min(confidence)::double precision AS min,
        max(confidence)::double precision AS max
      FROM access_svc.access_logs
      WHERE created_at >= ${since}
        AND (person_id IS NOT NULL OR reason = 'BELOW_THRESHOLD')
        ${siteFilter}
      GROUP BY 1
    `;

    return {
      recognized: this.toBuckets(rows, 'recognized'),
      unrecognized: this.toBuckets(rows, 'unrecognized'),
      recognizedStats: toCloudStats(extremes, 'recognized'),
      unrecognizedStats: toCloudStats(extremes, 'unrecognized'),
    };
  }

  /**
   * Rellena los intervalos vacíos.
   *
   * `GROUP BY` solo devuelve los que tienen datos, y un histograma con
   * huecos se dibuja torcido: las barras se apelotonarían saltándose
   * los tramos sin observaciones.
   */
  private toBuckets(
    rows: Array<{ cloud: string; bucket: number; count: bigint }>,
    cloud: string,
  ): SimilarityBucket[] {
    const width = (SIMILARITY_MAX - SIMILARITY_MIN) / SIMILARITY_BUCKETS;
    const counts = new Map<number, number>();

    for (const row of rows) {
      if (row.cloud !== cloud) continue;
      // `width_bucket` numera desde 1; devuelve 0 por debajo del rango y
      // N+1 por encima. Los extremos se pliegan al primer y último
      // intervalo en lugar de perderse.
      const index = Math.min(
        Math.max(Number(row.bucket), 1),
        SIMILARITY_BUCKETS,
      );
      counts.set(index, (counts.get(index) ?? 0) + Number(row.count));
    }

    return Array.from({ length: SIMILARITY_BUCKETS }, (_, i) => {
      const from = SIMILARITY_MIN + i * width;
      return {
        from: Number(from.toFixed(4)),
        to: Number((from + width).toFixed(4)),
        count: counts.get(i + 1) ?? 0,
      };
    });
  }

  /**
   * Accesos por día de la semana y hora, en la hora local de la sede.
   *
   * Devuelve también los concedidos de cada celda: un pico de intentos
   * a las tres de la madrugada significa algo muy distinto según si se
   * concedieron o no.
   */
  async hourlyActivity(
    since: Date,
    timezone: string,
    siteId?: string,
  ): Promise<HourlyCell[]> {
    const siteFilter = siteId
      ? Prisma.sql`AND site_id = ${siteId}::uuid`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ weekday: number; hour: number; total: bigint; granted: bigint }>
    >`
      SELECT
        EXTRACT(DOW  FROM created_at AT TIME ZONE ${timezone})::int AS weekday,
        EXTRACT(HOUR FROM created_at AT TIME ZONE ${timezone})::int AS hour,
        count(*) AS total,
        count(*) FILTER (WHERE authenticated) AS granted
      FROM access_svc.access_logs
      WHERE created_at >= ${since}
        ${siteFilter}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;

    return rows.map((row) => ({
      weekday: row.weekday,
      hour: row.hour,
      total: Number(row.total),
      granted: Number(row.granted),
    }));
  }
}

/** Extrae el resumen de una nube, o uno vacío si no tuvo muestras. */
function toCloudStats(
  rows: Array<{ cloud: string; samples: bigint; min: number; max: number }>,
  cloud: string,
): CloudStats {
  const row = rows.find((candidate) => candidate.cloud === cloud);
  if (!row) return { samples: 0, min: null, max: null };

  return {
    samples: Number(row.samples),
    min: Number(row.min),
    max: Number(row.max),
  };
}
