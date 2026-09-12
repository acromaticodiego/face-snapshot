import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StatsRepository } from './stats.repository';
import { analyzeThreshold } from './threshold.analysis';

/**
 * Estadísticas para el panel de operación.
 *
 * Misma separación que en el resto del servicio: aquí está la
 * orquestación y la E/S; el análisis del umbral es una función pura
 * aparte, probada por su cuenta.
 */
@Injectable()
export class StatsService {
  private readonly threshold: number;

  constructor(
    private readonly repository: StatsRepository,
    config: ConfigService,
  ) {
    // El mismo valor con el que decide el Face Service. Se lee de la
    // configuración y no se escribe a mano: un panel que analiza un
    // umbral distinto del que está en uso sería peor que no tenerlo.
    this.threshold = Number(config.get('RECOGNITION_THRESHOLD', 0.38));
  }

  async denials(params: { since: Date; siteId?: string }) {
    const [byReason, summary] = await Promise.all([
      this.repository.denialsByReason(params.since, params.siteId),
      this.repository.summary(params.since, params.siteId),
    ]);

    return {
      since: params.since.toISOString(),
      ...summary,
      byReason,
    };
  }

  /**
   * La distribución de similitudes, con su lectura.
   *
   * No devuelve solo los dos histogramas: devuelve además qué implican
   * para el umbral en uso, y con qué reservas. Un gráfico que hay que
   * interpretar a ojo no cambia ninguna decisión; un "el desconocido
   * que más se acercó se quedó a 0.03 del umbral", sí.
   */
  async similarity(params: { since: Date; siteId?: string }) {
    const histogram = await this.repository.similarityHistogram(
      params.since,
      params.siteId,
    );

    return {
      since: params.since.toISOString(),
      threshold: this.threshold,
      recognized: histogram.recognized,
      unrecognized: histogram.unrecognized,
      analysis: analyzeThreshold(
        histogram.recognizedStats,
        histogram.unrecognizedStats,
        this.threshold,
      ),
    };
  }

  async hourly(params: { since: Date; siteId?: string }) {
    const timezone = await this.repository.resolveTimezone(params.siteId);
    const cells = await this.repository.hourlyActivity(
      params.since,
      timezone,
      params.siteId,
    );

    return {
      since: params.since.toISOString(),
      // Se devuelve la zona usada para que el panel pueda decirlo: un
      // mapa de calor sin saber en qué huso está es una tabla de
      // números sin sentido.
      timezone,
      cells,
    };
  }
}
