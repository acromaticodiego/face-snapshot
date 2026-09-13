/**
 * Lo que ocurre entre el borrador y la firma.
 *
 * POR QUE ESTO ES UN MODULO APARTE Y NO CODIGO DENTRO DE LA PANTALLA
 * ─────────────────────────────────────────────────────────────────
 * Es la única parte de la interfaz de la bitácora que decide algo, y
 * lo que decide acaba guardado para siempre en un registro que no se
 * puede editar. Separarlo permite probarlo sin montar nada y sin
 * simular un micrófono.
 *
 * LA REGLA QUE SOSTIENE TODO ESTE ARCHIVO
 * ───────────────────────────────────────
 * Cada incidencia firmada declara **de dónde salió**: si el modelo la
 * propuso y se aceptó tal cual, si se propuso y la persona la corrigió,
 * o si el modelo no la vio y la escribió ella.
 *
 * Solo el cliente puede saberlo. El servidor no ve la propuesta
 * original ni lo que se tocó antes de firmar, así que si esto se
 * calcula mal, el dato que debía responder «¿aporta algo el modelo?»
 * pasa a responder cualquier otra cosa.
 */

import type {
  IncidentCategory,
  IncidentOrigin,
  IncidentSeverity,
  HandoverPayload,
  ProposedIncident,
} from './api';

/** Los campos de una incidencia que una persona puede cambiar. */
export interface EditableFields {
  title: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  mentionedTime: string;
  requiresFollowUp: boolean;
}

/**
 * Una incidencia mientras se revisa.
 *
 * Lleva al lado lo que propuso el modelo (`proposed`), que es lo que
 * permite saber después si se tocó. La cita y su verificación NO son
 * editables: son del Voice Service y describen la propuesta, no lo que
 * la persona decidió.
 */
export interface EditableIncident extends EditableFields {
  key: string;
  quote: string;
  quoteVerified: boolean;
  /** `null` cuando la escribió la persona y el modelo no la vio. */
  proposed: EditableFields | null;
}

/** Cómo llega una incidencia recién escrita a mano. */
export function emptyIncident(key: string): EditableIncident {
  return {
    key,
    title: '',
    // OTRO y BAJA de partida: el valor prudente es el que no afirma
    // nada. Empezar en ALTA o en SEGURIDAD metería una gravedad que
    // nadie ha declarado en cuanto alguien se deje el campo como está.
    category: 'OTRO',
    severity: 'BAJA',
    mentionedTime: '',
    requiresFollowUp: false,
    quote: '',
    quoteVerified: false,
    proposed: null,
  };
}

/** Convierte lo que propuso el Voice Service en algo editable. */
export function fromProposed(
  propuesta: ProposedIncident,
  key: string,
): EditableIncident {
  const campos: EditableFields = {
    title: propuesta.titulo,
    category: propuesta.categoria,
    severity: propuesta.gravedad,
    mentionedTime: propuesta.horaMencionada ?? '',
    requiresFollowUp: propuesta.requiereSeguimiento,
  };

  return {
    key,
    // El `...campos` de aquí es lo que hace que los campos editables
    // sean independientes de `proposed`: al extenderlos se copian, así
    // que escribir sobre la incidencia no toca la propuesta.
    ...campos,
    quote: propuesta.citaLiteral,
    quoteVerified: propuesta.citaVerificada,
    // La segunda copia es redundante hoy, y se deja a propósito: sin
    // ella, cualquier cambio futuro en cómo se construye la incidencia
    // -asignar los campos uno a uno, por ejemplo- volvería a unir las
    // dos caras en silencio.
    //
    // Que es redundante no es una suposición: se comprobó quitándola y
    // los tests siguieron pasando, porque el fallo que describía no
    // puede ocurrir mientras el spread de arriba esté.
    proposed: { ...campos },
  };
}

/**
 * De dónde salió esta incidencia.
 *
 * Se compara con los textos recortados: añadir un espacio al final no
 * es corregir nada, y contarlo como edición ensuciaría el único dato
 * que dice si el modelo acierta.
 */
export function originOf(incidencia: EditableIncident): IncidentOrigin {
  const { proposed } = incidencia;
  if (!proposed) return 'ANADIDA_POR_PERSONA';

  const igual =
    proposed.title.trim() === incidencia.title.trim() &&
    proposed.category === incidencia.category &&
    proposed.severity === incidencia.severity &&
    proposed.mentionedTime.trim() === incidencia.mentionedTime.trim() &&
    proposed.requiresFollowUp === incidencia.requiresFollowUp;

  return igual ? 'PROPUESTA_ACEPTADA' : 'PROPUESTA_EDITADA';
}

/** Motivos por los que un parte todavía no se puede firmar. */
export type BlockingReason =
  | 'SIN_JORNADA'
  | 'SIN_RESUMEN'
  | 'INCIDENCIA_SIN_TITULO';

/**
 * Qué impide firmar, si es que algo lo impide.
 *
 * Se comprueba aquí ADEMAS de en el servidor, y no en vez de: el
 * servidor es quien manda, pero descubrir en el último clic que falta
 * el resumen, después de dictar dos minutos, es una forma tonta de
 * perder un parte.
 */
export function blockingReason(parte: {
  siteId: string | null;
  summary: string;
  incidents: EditableIncident[];
}): BlockingReason | null {
  // Sin jornada abierta no hay sede a la que imputar el parte ni
  // periodo que cubra. El parte se dicta durante el turno.
  if (!parte.siteId) return 'SIN_JORNADA';

  // Un parte sin resumen no dice nada. Sin incidencias sí es válido y
  // corriente: la mayoría de los turnos no tienen ninguna, y exigir al
  // menos una empujaría a inventarse algo.
  if (!parte.summary.trim()) return 'SIN_RESUMEN';

  if (parte.incidents.some((i) => !i.title.trim())) {
    return 'INCIDENCIA_SIN_TITULO';
  }

  return null;
}

export const BLOCKING_MESSAGES: Record<BlockingReason, string> = {
  SIN_JORNADA:
    'Necesitas una jornada abierta para firmar un parte: se dicta durante el turno.',
  SIN_RESUMEN: 'Escribe un resumen del turno antes de firmar.',
  INCIDENCIA_SIN_TITULO: 'Hay una incidencia sin título.',
};

/**
 * Construye el cuerpo que se firma.
 *
 * El periodo NO lo inventa el servidor: lo declara quien firma, y aquí
 * se propone el que tiene sentido —desde que empezó la jornada hasta
 * ahora— para que no haya que escribirlo a mano.
 */
export function toPayload(parte: {
  siteId: string;
  coversFrom: string;
  coversTo: string;
  transcript: string | null;
  summary: string;
  transcriptionModel: string | null;
  structuringModel: string | null;
  incidents: EditableIncident[];
}): HandoverPayload {
  // DICTADO solo si de verdad hay transcripción. El servidor rechaza un
  // parte que dice estar dictado y no la trae, y con razón: afirmaría
  // que hubo audio sin dejar rastro de lo que se dijo.
  const dictado = Boolean(parte.transcript?.trim());

  return {
    siteId: parte.siteId,
    coversFrom: parte.coversFrom,
    coversTo: parte.coversTo,
    source: dictado ? 'DICTADO' : 'ESCRITO',
    ...(dictado ? { transcript: parte.transcript!.trim() } : {}),
    summary: parte.summary.trim(),
    ...(dictado && parte.transcriptionModel
      ? { transcriptionModel: parte.transcriptionModel }
      : {}),
    ...(dictado && parte.structuringModel
      ? { structuringModel: parte.structuringModel }
      : {}),
    incidents: parte.incidents.map((i) => ({
      title: i.title.trim(),
      category: i.category,
      severity: i.severity,
      ...(i.mentionedTime.trim() ? { mentionedTime: i.mentionedTime.trim() } : {}),
      requiresFollowUp: i.requiresFollowUp,
      origin: originOf(i),
      ...(i.quote.trim() ? { quote: i.quote.trim() } : {}),
      // Una incidencia escrita a mano nunca lleva cita del modelo, así
      // que nunca puede ir marcada como respaldada por él.
      quoteVerified: i.proposed !== null && i.quoteVerified,
    })),
  };
}

/** Periodo que se propone por defecto: la jornada en curso. */
export function defaultPeriod(
  startedAt: string | null,
  now: Date = new Date(),
): { coversFrom: string; coversTo: string } {
  const fin = now.toISOString();

  if (startedAt) {
    const inicio = new Date(startedAt);
    // El servidor no acepta periodos de más de 24 horas. Una jornada
    // que lleve abierta más que eso es una que nadie cerró, y el parte
    // no tiene por qué morir con ella: se recorta a las últimas 24 h.
    const limite = new Date(now.getTime() - 24 * 3600 * 1000 + 60_000);
    return {
      coversFrom: (inicio < limite ? limite : inicio).toISOString(),
      coversTo: fin,
    };
  }

  return {
    coversFrom: new Date(now.getTime() - 8 * 3600 * 1000).toISOString(),
    coversTo: fin,
  };
}
