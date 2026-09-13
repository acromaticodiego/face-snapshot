import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

/**
 * Cliente del Access Service.
 *
 * LA UNICA DEPENDENCIA SALIENTE DE ESTE SERVICIO
 * ──────────────────────────────────────────────
 * Y va en un solo sentido: el Access Service no sabe que la bitácora
 * existe. Es la misma dirección que ya tiene `access → face`, y evita
 * el ciclo que el ADR 0007 se cuidó de no crear con los turnos.
 *
 * Todas las llamadas de red viven aquí, como en el resto del proyecto
 * (ADR 0005): cambiar el transporte significa reescribir este archivo,
 * no rastrear peticiones por la base de código.
 *
 * QUE SI FALLA NO IMPIDA FIRMAR
 * ─────────────────────────────
 * El cruce con los registros de acceso enriquece el parte; no es el
 * parte. Si el Access Service no responde, se firma igual y el cruce
 * queda a nulo. La alternativa —devolver un error y perder lo que
 * alguien acaba de dictar— sería exactamente la dirección de fallo
 * equivocada, la misma que el proyecto evita en la puerta, en la
 * votación y en la telemetría.
 */

/** Lo que interesa de una sede al firmar. */
export interface SiteContext {
  id: string;
  name: string;
  timezone: string;
}

export interface WindowSummary {
  site: SiteContext | null;
  window: { from: string; to: string };
  totals: { attempts: number; granted: number; denied: number };
  byReason: Array<{ reason: string; count: number }>;
  anomalies: Array<{ anomaly: string | null; count: number }>;
  notable: unknown[];
  notableTruncated: boolean;
}

@Injectable()
export class AccessClient {
  private readonly logger = new Logger(AccessClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: process.env.ACCESS_SERVICE_URL ?? 'http://access-service:3002',
      // Plazo CORTO y a propósito. Quien firma un parte está esperando
      // delante de la pantalla, y este dato es un extra: más vale
      // firmarlo sin cruce en dos segundos que tenerlo esperando diez
      // por algo que no cambia lo que declaró.
      timeout: Number(process.env.ACCESS_TIMEOUT_MS ?? 2_000),
    });
  }

  /**
   * Resumen de lo que registraron las puertas en la franja del parte.
   *
   * Devuelve `null` ante cualquier problema y NO lanza: quien llama ya
   * sabe seguir sin esto, y convertirlo en excepción solo daría ocasión
   * de perder un parte por un servicio vecino lento.
   */
  async windowSummary(params: {
    from: string;
    to: string;
    siteId: string;
  }): Promise<WindowSummary | null> {
    try {
      const { data } = await this.http.get<WindowSummary>('/api/v1/access-logs/window', {
        params,
      });
      return data;
    } catch (error) {
      // El motivo se registra pero no se propaga: el cuerpo de un error
      // de otro servicio puede llevar detalles internos, y aquí acabaría
      // guardado dentro de un parte.
      this.logger.warn(
        `Sin cruce de accesos para el parte: ${
          axios.isAxiosError(error)
            ? `Access Service respondió ${error.response?.status ?? 'nada'}`
            : (error as Error).message
        }`,
      );
      return null;
    }
  }
}
