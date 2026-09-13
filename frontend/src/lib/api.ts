/**
 * Cliente HTTP del API Gateway.
 *
 * El frontend habla ÚNICAMENTE con el Gateway. No conoce la existencia
 * del Face Service, del Access Service ni del Vision Service, y no toma
 * ninguna decisión de autorización: se limita a mostrar el veredicto que
 * recibe.
 */

import { adminSession } from './auth';

const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceVerdict {
  bbox: BoundingBox;
  recognized: boolean;
  personName: string | null;
  personId: string | null;
  confidence: number;
}

export type AccessReason =
  | 'GRANTED'
  | 'BELOW_THRESHOLD'
  | 'NO_FACE_DETECTED'
  | 'MULTIPLE_FACES'
  | 'LOW_QUALITY'
  | 'INSUFFICIENT_VOTES'
  | 'PERSON_SUSPENDED'
  // Reconocido, pero sin permiso para pasar por aquí y ahora.
  | 'NO_ROLE_ASSIGNED'
  | 'NO_PERMISSION_FOR_ZONE'
  | 'OUTSIDE_SCHEDULE'
  | 'ASSIGNMENT_EXPIRED'
  | 'ACCESS_POINT_DISABLED'
  // La captura no parece una persona, sino una foto o una pantalla.
  | 'LIVENESS_FAILED'
  // Reconocido y con permiso, pero el sistema ya te considera dentro.
  | 'ANTIPASSBACK_VIOLATION';

/** Sentido de un paso concedido. */
export type Passage = 'IN' | 'OUT';

export interface VerifyFrameResponse {
  authenticated: boolean;
  person: { id: string; name: string } | null;
  confidence: number;
  bbox: BoundingBox | null;
  faces: FaceVerdict[];
  /** Dimensiones del frame analizado; las cajas están en este espacio. */
  imageWidth: number;
  imageHeight: number;
  reason: AccessReason;
  sessionKey: string;
  votes: { current: number; required: number };
  accessToken?: string;
  /** Dónde está este terminal. */
  location?: { site: string; zone: string; accessPoint: string };
  /** Si el acceso concedido fue una entrada o una salida. */
  passage?: Passage;
}

// ── Jornada laboral ───────────────────────────────────────────────

export type ShiftState = 'FUERA' | 'EN_TURNO' | 'EN_DESCANSO' | 'EN_PAUSA';

export interface ShiftSummary {
  state: ShiftState;
  /** Desde cuándo está en ese estado. */
  since: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Incluye el tramo en curso, no solo lo ya consolidado. */
  workedSeconds: number;
  breakSeconds: number;
  /**
   * Sede de la jornada abierta. Nulo cuando no hay ninguna.
   *
   * Es de donde sale el `siteId` de un parte de relevo: el terminal
   * conoce su puerta, no su sede, así que sin este campo el frontend
   * no tiene forma de decir a qué sede corresponde el parte.
   */
  siteId: string | null;
  siteName: string | null;
}

/** Motivos que se pueden declarar al empezar un descanso. */
export type BreakNote = 'DESCANSO' | 'ALMUERZO' | 'BANO' | 'OTRO';

export interface TimelineEntry {
  at: string;
  fromState: ShiftState;
  toState: ShiftState;
  direction: 'IN' | 'OUT' | null;
  zoneName: string | null;
  accessPointName: string | null;
  /** Quién provocó la transición: una puerta, la persona o el sistema. */
  origin: 'ACCESS' | 'MANUAL' | 'SYSTEM';
  /** Motivo declarado, solo en las entradas manuales. */
  note: BreakNote | null;
}

export interface WorkDay {
  id: string;
  businessDate: string;
  state: ShiftState;
  startedAt: string;
  endedAt: string | null;
  /** Nulo si la cerró un paso real; TIMEOUT o STALE si la cerró el sistema. */
  closedBy: 'TIMEOUT' | 'STALE' | null;
  workedSeconds: number;
  breakSeconds: number;
  siteName: string;
  entries: TimelineEntry[];
}

// ── Panel de operación ────────────────────────────────────────────

export interface PresenceRow {
  personId: string;
  zoneId: string;
  zoneName: string;
  zoneShiftEffect: 'WORK' | 'BREAK' | 'NEUTRAL';
  siteId: string;
  lastDirection: string;
  lastPassageAt: string;
}

export interface PresenceResponse {
  items: PresenceRow[];
  occupancyByZone: Record<string, { zoneName: string; count: number }>;
  /** Personas distintas: quien está en el laboratorio consta también
   *  dentro de las oficinas, así que sumar zonas inflaría el aforo. */
  totalPeople: number;
}

export interface OpenShiftsResponse {
  items: Array<{
    personId: string;
    personName: string;
    state: ShiftState;
    since: string;
    startedAt: string;
    siteName: string;
  }>;
  countsByState: Partial<Record<ShiftState, number>>;
}

export interface DenialsResponse {
  since: string;
  granted: number;
  denied: number;
  anomalies: number;
  byReason: Array<{ reason: AccessReason; count: number }>;
}

export interface SimilarityBucket {
  from: number;
  to: number;
  count: number;
}

export interface SimilarityResponse {
  since: string;
  threshold: number;
  recognized: SimilarityBucket[];
  unrecognized: SimilarityBucket[];
  analysis: {
    threshold: number;
    verdict: 'HOLGADO' | 'AJUSTADO' | 'SOLAPADO' | 'SIN_DATOS';
    separation: number | null;
    marginBelow: number | null;
    marginAbove: number | null;
    recognized: { samples: number; min: number | null; max: number | null };
    unrecognized: { samples: number; min: number | null; max: number | null };
    caveat: string;
  };
}

export interface HourlyResponse {
  since: string;
  timezone: string;
  cells: Array<{
    weekday: number;
    hour: number;
    total: number;
    granted: number;
  }>;
}

export interface AccessLogRow {
  id: string;
  personId: string | null;
  personName: string | null;
  authenticated: boolean;
  confidence: number;
  reason: AccessReason;
  anomaly: 'ANTIPASSBACK_SOFT' | 'DUPLICATE_PASSAGE' | null;
  zoneName: string | null;
  accessPointName: string | null;
  direction: 'IN' | 'OUT' | 'BOTH' | null;
  createdAt: string;
}

/** Un rol asignado a una persona. */
export interface PersonRole {
  roleId: string;
  roleName: string;
}

/** Un rol del catalogo, con las zonas y horarios que habilita. */
export interface Role {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  permissions: { zone: string; schedule: string }[];
}

export interface Person {
  id: string;
  fullName: string;
  externalId: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  enrolledFacesCount: number;
  /**
   * Roles asignados, o `null` si no se pudieron consultar.
   *
   * Los roles viven en otro servicio que el Gateway consulta aparte,
   * asi que `null` significa «no se sabe» y la lista vacia significa
   * «no tiene ninguno». La diferencia importa: lo segundo es una
   * persona que no puede pasar por ninguna puerta y hay que arreglar;
   * lo primero es una averia y pintarla como lo segundo mandaria al
   * administrador a perseguir un problema inexistente.
   */
  roles: PersonRole[] | null;
  createdAt: string;
  updatedAt: string;
}

// ── Bitácora de relevo de turno ───────────────────────────────────

export type IncidentCategory =
  | 'ACCESO'
  | 'ALARMA'
  | 'MANTENIMIENTO'
  | 'SEGURIDAD'
  | 'OTRO';

export type IncidentSeverity = 'BAJA' | 'MEDIA' | 'ALTA';

/**
 * De dónde salió una incidencia.
 *
 * Lo declara el cliente porque es el único que lo sabe: el servidor no
 * ve la propuesta original ni lo que la persona tocó antes de firmar.
 * Sirve para poder responder, con datos, si el modelo aporta algo.
 */
export type IncidentOrigin =
  | 'PROPUESTA_ACEPTADA'
  | 'PROPUESTA_EDITADA'
  | 'ANADIDA_POR_PERSONA';

/** Una incidencia tal y como la propone el Voice Service. */
export interface ProposedIncident {
  titulo: string;
  categoria: IncidentCategory;
  gravedad: IncidentSeverity;
  horaMencionada?: string | null;
  requiereSeguimiento: boolean;
  citaLiteral: string;
  /**
   * Si esa cita aparece de verdad en la transcripción.
   *
   * Lo comprueba el Voice Service comparando contra el texto; no lo
   * dice el modelo. Una incidencia con `false` no se oculta: se marca,
   * para que quien revisa sepa cuál no está respaldada por lo que dijo.
   */
  citaVerificada: boolean;
}

export interface LogbookDraft {
  transcripcion: {
    texto: string;
    confianza: number;
    duracionSegundos: number;
    modelo: string;
  };
  estructura: {
    resumen: string;
    incidencias: ProposedIncident[];
  } | null;
  /** Por qué no hay estructura, cuando no la hay. */
  estructuraOmitidaPor: string | null;
  /**
   * Qué modelo produjo la estructura, con su versión concreta.
   *
   * Se guarda en el parte firmado. Apuntar «gemini» a secas no serviría
   * para lo que este dato existe: poder encontrar qué partes pasaron
   * por una versión si se descubre que agrupaba mal.
   */
  modeloEstructurador: string | null;
  processingTimeMs: number;
  transcribeTimeMs: number;
  structureTimeMs: number | null;
}

/** Lo que se envía al firmar. */
export interface HandoverPayload {
  siteId: string;
  coversFrom: string;
  coversTo: string;
  source: 'DICTADO' | 'ESCRITO';
  transcript?: string;
  summary: string;
  transcriptionModel?: string;
  structuringModel?: string;
  incidents: Array<{
    title: string;
    category: IncidentCategory;
    severity: IncidentSeverity;
    mentionedTime?: string;
    requiresFollowUp: boolean;
    origin: IncidentOrigin;
    quote?: string;
    quoteVerified: boolean;
  }>;
}

export interface HandoverEntry {
  id: string;
  personName: string;
  siteName: string | null;
  businessDate: string;
  coversFrom: string;
  coversTo: string;
  source: 'DICTADO' | 'ESCRITO';
  summary: string;
  incidents: Array<{
    id: string;
    title: string;
    category: IncidentCategory;
    severity: IncidentSeverity;
    mentionedTime: string | null;
    requiresFollowUp: boolean;
    origin: IncidentOrigin;
    quote: string | null;
    quoteVerified: boolean;
  }>;
}

export interface PendingIncident {
  id: string;
  title: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  mentionedTime: string | null;
  quote: string | null;
  quoteVerified: boolean;
  entry: {
    id: string;
    personName: string;
    siteName: string | null;
    businessDate: string;
    coversTo: string;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parseError(response: Response): Promise<never> {
  let message = `Error ${response.status}`;
  let code: string | undefined;

  try {
    const body = await response.json();
    message = body.message ?? message;
    code = body.code;
    if (Array.isArray(body.details) && body.details.length > 0) {
      message = body.details
        .map((d: { field: string; message: string }) => `${d.field}: ${d.message}`)
        .join(', ');
    }
  } catch {
    // El cuerpo no era JSON; se conserva el mensaje genérico.
  }

  throw new ApiError(message, response.status, code);
}

/**
 * Token de sesión facial, el que emite el Access Service al reconocer.
 *
 * Es DISTINTO del de administrador y no son intercambiables: el guard
 * del Gateway comprueba el tipo en los dos sentidos. Un token de
 * administración no sirve en /me/* porque esas rutas responden sobre el
 * sujeto del token, y una cuenta de administración no es una persona
 * reconocible por la cámara.
 */
function getSessionToken(): string | null {
  try {
    return sessionStorage.getItem('accessToken');
  } catch {
    // Modo privado o almacenamiento bloqueado por el navegador.
    return null;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Las rutas de administracion viajan con el token de administrador;
  // las de /me, con el de la sesion facial. Las de autenticacion son
  // publicas por diseno: quien se identifica ante la camara todavia no
  // tiene ninguna sesion.
  const needsAuth = path.startsWith('/admin') && !path.startsWith('/admin/auth/login');
  const needsSession = path.startsWith('/me');

  if (needsAuth) {
    const token = adminSession.getToken();
    if (token) {
      init.headers = { ...init.headers, Authorization: `Bearer ${token}` };
    }
  }

  if (needsSession) {
    const token = getSessionToken();
    if (token) {
      init.headers = { ...init.headers, Authorization: `Bearer ${token}` };
    }
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, init);
  } catch {
    // fetch solo rechaza por fallo de red, no por códigos HTTP de error.
    throw new ApiError(
      'No se pudo conectar con el servidor. Comprueba que los servicios estén en marcha.',
      0,
      'NETWORK_ERROR',
    );
  }

  // Token caducado o invalido: se limpia la sesion para que la interfaz
  // devuelva al login en lugar de quedarse mostrando errores sueltos.
  if (response.status === 401 && needsAuth) {
    adminSession.clear();
  }

  if (!response.ok) await parseError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/**
 * Puerta física en la que está montado este terminal.
 *
 * Va en la configuración del despliegue, NO la elige quien entra: si el
 * usuario pudiera escoger el punto de acceso, bastaría con decir que
 * está en una puerta a la que sí tiene permiso.
 */
const TERMINAL_KEY = import.meta.env.VITE_TERMINAL_KEY ?? 'main-entrance';

export const api = {
  /** Envía un frame y recibe el veredicto de acceso. */
  async verifyFrame(
    frame: Blob,
    sessionKey?: string,
    signal?: AbortSignal,
  ): Promise<VerifyFrameResponse> {
    const form = new FormData();
    form.append('file', frame, 'frame.jpg');
    form.append('terminalKey', TERMINAL_KEY);
    if (sessionKey) form.append('sessionKey', sessionKey);

    return request<VerifyFrameResponse>('/auth/verify-frame', {
      method: 'POST',
      body: form,
      signal,
    });
  },

  async listPersons(search?: string): Promise<{ items: Person[]; total: number }> {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    return request(`/admin/persons${query}`);
  },

  async createPerson(data: {
    fullName: string;
    externalId?: string;
  }): Promise<Person> {
    return request('/admin/persons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  async listRoles(): Promise<{ items: Role[] }> {
    return request('/admin/roles');
  },

  async assignRole(
    personId: string,
    roleId: string,
  ): Promise<PersonRole & { id: string }> {
    return request(`/admin/persons/${personId}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId }),
    });
  },

  async revokeRole(
    personId: string,
    roleId: string,
  ): Promise<{ revoked: boolean }> {
    return request(`/admin/persons/${personId}/roles/${roleId}`, {
      method: 'DELETE',
    });
  },

  async deletePerson(id: string): Promise<{ deletedEmbeddings: number }> {
    return request(`/admin/persons/${id}`, { method: 'DELETE' });
  },

  async enrollFace(
    personId: string,
    image: Blob,
  ): Promise<{ faceId: string; detectionScore: number; enrolledFacesCount: number }> {
    const form = new FormData();
    form.append('file', image, 'capture.jpg');
    return request(`/admin/persons/${personId}/faces`, {
      method: 'POST',
      body: form,
    });
  },

  async adminLogin(
    email: string,
    password: string,
  ): Promise<{
    accessToken: string;
    expiresIn: string;
    admin: { id: string; email: string; displayName: string; role: string };
  }> {
    return request('/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  },

  /** Comprueba si el token guardado sigue siendo valido. */
  async adminMe(): Promise<{
    id: string;
    email: string;
    displayName: string;
    role: string;
  }> {
    return request('/admin/auth/me');
  },

  // ── Sobre uno mismo ───────────────────────────────────────────
  //
  // El identificador NO viaja en la peticion: lo lee el Gateway del
  // token. Si se aceptara como parametro, cualquiera con una sesion
  // valida podria leer la jornada de sus companeros cambiando un
  // numero en la barra del navegador.

  async myShift(): Promise<ShiftSummary> {
    return request('/me/shift');
  },

  async myTimeline(): Promise<{ items: WorkDay[] }> {
    return request('/me/timeline');
  },

  /**
   * Declara un descanso propio.
   *
   * Solo mueve el estado dentro de la sede. Entrar y salir siguen
   * siendo cosa de la cámara: no hay forma de fichar desde aquí.
   */
  async startBreak(note: BreakNote): Promise<ShiftSummary> {
    return request('/me/shift/break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
  },

  async endBreak(): Promise<ShiftSummary> {
    return request('/me/shift/resume', { method: 'POST' });
  },

  // ── Bitácora de relevo de turno ───────────────────────────────

  /**
   * Convierte un dictado en un borrador estructurado.
   *
   * NO guarda nada. Lo que vuelve es una propuesta que hay que revisar
   * y firmar aparte. Si el estructurador no responde, llega solo la
   * transcripción y `estructuraOmitidaPor` explica por qué: el parte se
   * puede firmar igual.
   */
  async logbookDraft(audio: Blob): Promise<LogbookDraft> {
    const form = new FormData();
    // El nombre importa poco, el tipo sí: el Gateway comprueba la
    // cabecera del archivo antes de mandarlo a un tercero.
    form.append('file', audio, 'parte.webm');
    return request('/me/logbook/draft', { method: 'POST', body: form });
  },

  /** Firma un parte. Lo que se firma aquí es INMUTABLE. */
  async signHandover(payload: HandoverPayload): Promise<HandoverEntry> {
    return request('/me/logbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async myHandovers(take = 5): Promise<{ items: HandoverEntry[]; total: number }> {
    return request(`/me/logbook?take=${take}`);
  },

  /**
   * Lo que quedó sin cerrar, para quien entra al turno.
   *
   * No filtra por persona a propósito: lo pendiente lo dejó otro.
   */
  async pendingIncidents(
    days = 7,
  ): Promise<{ items: PendingIncident[]; total: number; sinceDays: number }> {
    return request(`/me/logbook/pending?days=${days}`);
  },

  // ── Panel de operacion (exige token de administrador) ─────────

  async presence(): Promise<PresenceResponse> {
    return request('/admin/presence');
  },

  async openShifts(): Promise<OpenShiftsResponse> {
    return request('/admin/shifts');
  },

  async accessLogs(take = 20): Promise<{ items: AccessLogRow[]; total: number }> {
    return request(`/admin/access-logs?take=${take}`);
  },

  async denialStats(days = 7): Promise<DenialsResponse> {
    return request(`/admin/stats/denials?days=${days}`);
  },

  async similarityStats(days = 30): Promise<SimilarityResponse> {
    return request(`/admin/stats/similarity?days=${days}`);
  },

  async hourlyStats(days = 28): Promise<HourlyResponse> {
    return request(`/admin/stats/hourly?days=${days}`);
  },

  async health(): Promise<{ status: string }> {
    return request('/health');
  },
};
