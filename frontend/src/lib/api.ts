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
  siteName: string | null;
}

export interface TimelineEntry {
  at: string;
  fromState: ShiftState;
  toState: ShiftState;
  direction: 'IN' | 'OUT' | null;
  zoneName: string | null;
  accessPointName: string | null;
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

export interface Person {
  id: string;
  fullName: string;
  externalId: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  enrolledFacesCount: number;
  createdAt: string;
  updatedAt: string;
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
