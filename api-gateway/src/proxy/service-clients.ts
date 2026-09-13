import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';

/**
 * Clientes hacia los microservicios.
 *
 * El Gateway no contiene NADA de lógica de reconocimiento: recibe, valida,
 * reenvía y normaliza errores. Toda la inteligencia vive detrás.
 */

abstract class BaseServiceClient {
  protected readonly logger: Logger;
  protected readonly http: AxiosInstance;

  protected constructor(name: string, baseURL: string, timeout: number) {
    this.logger = new Logger(name);
    this.http = axios.create({
      baseURL,
      timeout,
      maxContentLength: 20 * 1024 * 1024,
    });
  }

  /**
   * Traduce el fallo de un servicio interno a una respuesta HTTP.
   *
   * Nunca se propaga el cuerpo íntegro del error: podría contener
   * detalles internos. Se conserva el código y un mensaje seguro.
   */
  protected fail(error: unknown, fallback: string): never {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 503;
      const data = error.response?.data as
        | { message?: string; code?: string; details?: unknown }
        | undefined;

      this.logger.error(`Servicio interno respondió ${status}`);
      throw new HttpException(
        {
          message: data?.message ?? fallback,
          ...(data?.code ? { code: data.code } : {}),
          ...(data?.details ? { details: data.details } : {}),
        },
        status,
      );
    }
    throw error;
  }

  protected buildImageForm(
    image: Buffer,
    filename: string,
    mimetype: string,
    fields: Record<string, string | undefined> = {},
  ): FormData {
    const form = new FormData();
    form.append('file', image, { filename, contentType: mimetype });
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, value);
    }
    return form;
  }
}

@Injectable()
export class FaceServiceClient extends BaseServiceClient {
  constructor(config: ConfigService) {
    super(
      FaceServiceClient.name,
      config.get<string>('FACE_SERVICE_URL', 'http://localhost:3001'),
      12_000,
    );
  }

  async listPersons(query: Record<string, string | undefined>) {
    try {
      const { data } = await this.http.get('/api/v1/persons', { params: query });
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo obtener la lista de personas');
    }
  }

  async getPerson(id: string) {
    try {
      const { data } = await this.http.get(`/api/v1/persons/${id}`);
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo obtener la persona');
    }
  }

  async createPerson(body: { fullName: string; externalId?: string }) {
    try {
      const { data } = await this.http.post('/api/v1/persons', body);
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo crear la persona');
    }
  }

  async updatePerson(id: string, body: Record<string, unknown>) {
    try {
      const { data } = await this.http.patch(`/api/v1/persons/${id}`, body);
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo actualizar la persona');
    }
  }

  async deletePerson(id: string) {
    try {
      const { data } = await this.http.delete(`/api/v1/persons/${id}`);
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo eliminar la persona');
    }
  }

  async enrollFace(
    id: string,
    image: Buffer,
    filename: string,
    mimetype: string,
  ) {
    const form = this.buildImageForm(image, filename, mimetype);
    try {
      const { data } = await this.http.post(
        `/api/v1/persons/${id}/faces`,
        form,
        { headers: form.getHeaders() },
      );
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo registrar el rostro');
    }
  }

  async health() {
    const { data } = await this.http.get('/api/v1/health', { timeout: 3000 });
    return data;
  }
}

@Injectable()
export class AccessServiceClient extends BaseServiceClient {
  constructor(config: ConfigService) {
    super(
      AccessServiceClient.name,
      config.get<string>('ACCESS_SERVICE_URL', 'http://localhost:3002'),
      12_000,
    );
  }

  async stats(
    kind: 'denials' | 'similarity' | 'hourly',
    query: Record<string, string | undefined>,
  ) {
    try {
      const { data } = await this.http.get(`/api/v1/stats/${kind}`, {
        params: query,
      });
      return data;
    } catch (e) {
      this.fail(e, 'No se pudieron obtener las estadisticas');
    }
  }

  async listPresence(query: Record<string, string | undefined>) {
    try {
      const { data } = await this.http.get('/api/v1/presence', {
        params: query,
      });
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo obtener la presencia');
    }
  }

  async verifyFrame(params: {
    image: Buffer;
    filename: string;
    mimetype: string;
    sessionKey?: string;
    cameraId?: string;
    terminalKey?: string;
  }) {
    const form = this.buildImageForm(
      params.image,
      params.filename,
      params.mimetype,
      {
        sessionKey: params.sessionKey,
        cameraId: params.cameraId,
        terminalKey: params.terminalKey,
      },
    );
    try {
      const { data } = await this.http.post(
        '/api/v1/auth/verify-frame',
        form,
        { headers: form.getHeaders() },
      );
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo verificar el frame');
    }
  }

  async listSites() {
    try {
      const { data } = await this.http.get('/api/v1/sites');
      return data;
    } catch (e) {
      this.fail(e, 'No se pudieron obtener las sedes');
    }
  }

  async listRoles() {
    try {
      const { data } = await this.http.get('/api/v1/roles');
      return data;
    } catch (e) {
      this.fail(e, 'No se pudieron obtener los roles');
    }
  }

  async listPersonRoles(personId: string) {
    try {
      const { data } = await this.http.get(`/api/v1/persons/${personId}/roles`);
      return data;
    } catch (e) {
      this.fail(e, 'No se pudieron obtener los roles de la persona');
    }
  }

  /**
   * Roles de varias personas a la vez, para componer el listado.
   *
   * Devuelve `null` en lugar de propagar el fallo: los roles son un
   * dato ACCESORIO de la lista de personas, que vive en otro servicio.
   * Si el Access Service no responde, el administrador debe seguir
   * viendo a su gente y pudiendo capturar rostros; lo que no puede es
   * ver a todo el mundo marcado como «sin rol», porque le haría
   * perseguir un problema que no existe.
   */
  async lookupPersonRoles(
    personIds: string[],
  ): Promise<Record<string, { roleId: string; roleName: string }[]> | null> {
    if (personIds.length === 0) return {};
    try {
      const { data } = await this.http.post<{
        byPerson: Record<string, { roleId: string; roleName: string }[]>;
      }>(
        '/api/v1/persons/roles/lookup',
        { personIds },
        // Plazo propio, mucho más corto que los 12 s del cliente. Un
        // servicio COLGADO es peor que uno caído: sin este límite, el
        // listado de personas tardaría doce segundos en pintarse por
        // culpa de un dato accesorio. Es la misma lección que dejó el
        // /health del Shift Service con Redis caído.
        { timeout: 2_000 },
      );
      return data.byPerson;
    } catch (e) {
      this.logger.warn(
        `No se pudieron consultar los roles del listado: ${(e as Error).message}`,
      );
      return null;
    }
  }

  async assignRole(personId: string, body: Record<string, unknown>) {
    try {
      const { data } = await this.http.post(
        `/api/v1/persons/${personId}/roles`,
        body,
      );
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo asignar el rol');
    }
  }

  async revokeRole(personId: string, roleId: string) {
    try {
      const { data } = await this.http.delete(
        `/api/v1/persons/${personId}/roles/${roleId}`,
      );
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo retirar el rol');
    }
  }

  async listLogs(query: Record<string, string | undefined>) {
    try {
      const { data } = await this.http.get('/api/v1/access-logs', {
        params: query,
      });
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo obtener el historial de accesos');
    }
  }

  async health() {
    const { data } = await this.http.get('/api/v1/health', { timeout: 3000 });
    return data;
  }
}

/**
 * Cliente del Shift Service.
 *
 * Solo lecturas: la jornada se escribe consumiendo eventos, nunca por
 * HTTP. Que este cliente no tenga un solo metodo de escritura es la
 * forma mas clara de decir que la proyeccion no se puede tocar a mano.
 */
@Injectable()
export class ShiftServiceClient extends BaseServiceClient {
  constructor(config: ConfigService) {
    super(
      ShiftServiceClient.name,
      config.get<string>('SHIFT_SERVICE_URL', 'http://localhost:3004'),
      8_000,
    );
  }

  async currentShift(personId: string) {
    try {
      const { data } = await this.http.get(
        `/api/v1/shifts/${personId}/current`,
      );
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo obtener el estado de turno');
    }
  }

  async timeline(personId: string, date?: string) {
    try {
      const { data } = await this.http.get(
        `/api/v1/shifts/${personId}/timeline`,
        { params: date ? { date } : {} },
      );
      return data;
    } catch (e) {
      this.fail(e, 'No se pudo obtener la linea de tiempo');
    }
  }

  /**
   * Descanso declarado por la persona.
   *
   * Es la unica escritura de este cliente, y solo mueve el estado
   * DENTRO de la sede. Entrar y salir siguen siendo cosa del Access
   * Service con una cara delante de una camara.
   */
  async changeShift(
    personId: string,
    action: 'break' | 'resume',
    body: { note?: string } = {},
  ) {
    try {
      const { data } = await this.http.post(
        `/api/v1/shifts/${personId}/${action}`,
        body,
      );
      return data;
    } catch (e) {
      // El 409 del Shift Service llega con su motivo y su codigo, y se
      // propaga tal cual: "ya estabas en descanso" y "todavia no has
      // entrado" son mensajes distintos para quien esta delante.
      this.fail(e, 'No se pudo cambiar el estado de turno');
    }
  }

  async openShifts(query: Record<string, string | undefined>) {
    try {
      const { data } = await this.http.get('/api/v1/shifts', { params: query });
      return data;
    } catch (e) {
      this.fail(e, 'No se pudieron obtener las jornadas abiertas');
    }
  }

  async health() {
    const { data } = await this.http.get('/api/v1/health', { timeout: 3000 });
    return data;
  }
}

@Injectable()
export class AuthServiceClient extends BaseServiceClient {
  constructor(config: ConfigService) {
    super(
      AuthServiceClient.name,
      config.get<string>('AUTH_SERVICE_URL', 'http://localhost:3003'),
      8_000,
    );
  }

  async login(body: { email?: string; password?: string }) {
    try {
      const { data } = await this.http.post('/api/v1/admin/auth/login', body);
      return data;
    } catch (e) {
      // El mensaje del Auth Service ya es deliberadamente generico
      // ("Credenciales invalidas"): se propaga tal cual para no filtrar
      // si el correo existe.
      this.fail(e, 'No se pudo iniciar sesion');
    }
  }

  async health() {
    const { data } = await this.http.get('/api/v1/health', { timeout: 3000 });
    return data;
  }
}
