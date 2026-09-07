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

  async verifyFrame(params: {
    image: Buffer;
    filename: string;
    mimetype: string;
    sessionKey?: string;
    cameraId?: string;
  }) {
    const form = this.buildImageForm(
      params.image,
      params.filename,
      params.mimetype,
      { sessionKey: params.sessionKey, cameraId: params.cameraId },
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
