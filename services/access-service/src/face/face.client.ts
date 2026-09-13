import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';

export interface IdentifiedFace {
  bbox: { x: number; y: number; width: number; height: number };
  detectionScore: number;
  quality: {
    faceWidthPx: number;
    faceHeightPx: number;
    blurScore: number;
    truncated: boolean;
  };
  /**
   * Evidencia de vida medida por el Vision Service. Son NÚMEROS, no un
   * veredicto: la política de qué hacer con ellos vive aquí, en el
   * único servicio que decide si una puerta se abre.
   *
   * Opcional porque un Vision Service anterior a la Fase 6 no la envía,
   * y un despliegue escalonado no puede dejar a nadie fuera.
   */
  liveness?: {
    detailRatio: number;
    patternPeak: number;
  };
  match: {
    personId: string;
    fullName: string;
    status: string;
    similarity: number;
  } | null;
  bestSimilarity: number;
}

export interface IdentifyResponse {
  imageWidth: number;
  imageHeight: number;
  processingTimeMs: number;
  faces: IdentifiedFace[];
}

/**
 * Cliente del Face Service.
 *
 * El Access Service nunca habla con el Vision Service ni con la base de
 * datos de rostros: pregunta "¿quién es?" y recibe una identidad. Los
 * embeddings jamás cruzan esta frontera.
 */
@Injectable()
export class FaceClient {
  private readonly logger = new Logger(FaceClient.name);
  private readonly http: AxiosInstance;

  constructor(config: ConfigService) {
    this.http = axios.create({
      baseURL: config.get<string>('FACE_SERVICE_URL', 'http://localhost:3001'),
      timeout: 12_000,
      maxContentLength: 20 * 1024 * 1024,
    });
  }

  async identify(
    image: Buffer,
    filename: string,
    mimetype: string,
  ): Promise<IdentifyResponse> {
    const form = new FormData();
    form.append('file', image, { filename, contentType: mimetype });

    try {
      const { data } = await this.http.post<IdentifyResponse>(
        '/api/v1/recognition/identify',
        form,
        { headers: form.getHeaders() },
      );
      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status ?? 503;
        const message =
          (error.response?.data as { message?: string })?.message ??
          'El servicio de rostros no está disponible';
        this.logger.error(`Face Service respondió ${status}: ${message}`);
        throw new HttpException(message, status);
      }
      throw error;
    }
  }
}
