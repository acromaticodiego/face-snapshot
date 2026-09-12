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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Las rutas de administracion viajan siempre con el token; las de
  // autenticacion facial son publicas por diseno (el usuario que se
  // identifica ante la camara todavia no tiene ninguna sesion).
  const needsAuth = path.startsWith('/admin') && !path.startsWith('/admin/auth/login');
  if (needsAuth) {
    const token = adminSession.getToken();
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

  async health(): Promise<{ status: string }> {
    return request('/health');
  },
};
