/**
 * Eventos que publica el Access Service.
 *
 * Este archivo es la frontera del servicio: lo que aparece aquí es lo
 * que otros pueden consumir, y cambiarlo rompe a quien esté al otro
 * lado. Se mantiene deliberadamente pequeño.
 *
 * TODO VIAJA DENORMALIZADO
 * ────────────────────────
 * El evento lleva los nombres además de los identificadores, y el
 * efecto de la zona sobre la jornada. No es redundancia: es lo que
 * permite que el Shift Service interprete un paso sin preguntar nada a
 * nadie. En cuanto tuviera que consultar de vuelta, volveríamos a
 * tener el ciclo y la latencia que este diseño evita.
 *
 * Es además el mismo criterio que ya sigue `access_logs`: un hecho
 * histórico debe seguir describiendo lo que pasó aunque después se
 * renombre o se elimine la zona.
 */

export const ACCESS_EVENTS_STREAM = 'access.events';

/** Alguien pasó por una puerta. Es el único evento, de momento. */
export interface AccessGrantedEvent {
  /**
   * Identificador del evento, no del acceso.
   *
   * Es la clave de idempotencia del consumidor: la entrega es "al
   * menos una vez", así que un evento puede llegar repetido y el
   * consumidor tiene que reconocerlo por este valor.
   */
  eventId: string;
  type: 'AccessGranted';
  occurredAt: string;

  personId: string;
  personName: string;

  siteId: string;
  siteName: string;
  zoneId: string;
  zoneName: string;
  /** Si el tiempo en esta zona computa como jornada. */
  zoneShiftEffect: 'WORK' | 'BREAK' | 'NEUTRAL';
  accessPointId: string;
  accessPointName: string;

  direction: 'IN' | 'OUT';
  /** Anomalía anotada en la auditoría, si la hubo. */
  anomaly: 'ANTIPASSBACK_SOFT' | null;
}

export type AccessEvent = AccessGrantedEvent;
