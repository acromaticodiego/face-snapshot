import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';

export interface VisionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionDetectedFace {
  bbox: VisionBoundingBox;
  detectionScore: number;
  embedding: number[];
  quality: {
    faceWidthPx: number;
    faceHeightPx: number;
    blurScore: number;
    truncated: boolean;
  };
  /**
   * Evidencia de vida. NO es un veredicto: son medidas crudas sobre el
   * rostro, y quien decide qué significan es el Access Service, que es
   * el único que tiene política.
   *
   * El Face Service no mira ninguna de estas: las reenvía tal cual. Que
   * estén tipadas aquí es lo que evita que un cambio de nombre en el
   * Vision Service llegue en silencio hasta la decisión de acceso.
   */
  liveness: {
    /**
     * Probabilidad de cara real según MiniFASNet, en [0, 1]. Es la
     * única que decide algo (ADR 0014).
     *
     * Llega AUSENTE cuando no se pudo medir, nunca como 0.0: un cero
     * significaría «ataque segurísimo» y en modo HARD dejaría fuera a
     * una persona real por un fallo de medida.
     */
    spoofScore?: number | null;
    /** Refutada contra un ataque real: no separa. */
    detailRatio: number;
    /** Refutada contra un ataque real: marca MÁS alto con la cara real. */
    patternPeak: number;
  };
}

export interface VisionAnalyzeResult {
  faces: VisionDetectedFace[];
  imageWidth: number;
  imageHeight: number;
  processingTimeMs: number;
  modelInfo: {
    detector: string;
    detectorVersion: string;
    embedder: string;
    embedderVersion: string;
    spoofDetector?: string;
    spoofDetectorVersion?: string;
  };
}

/**
 * Cliente HTTP del Vision Service.
 *
 * Es el ÚNICO punto del Face Service que habla con Python. Si mañana la
 * comunicación pasa a gRPC o a una cola de mensajes, solo cambia este
 * archivo.
 */
@Injectable()
export class VisionClient {
  private readonly logger = new Logger(VisionClient.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: this.config.get<string>('VISION_SERVICE_URL', 'http://localhost:8000'),
      // La inferencia sobre CPU puede tardar; pero un frame que tarda más
      // de 10 s ya no sirve para nada en tiempo real.
      timeout: 10_000,
      maxContentLength: 20 * 1024 * 1024,
    });
  }

  async analyze(
    imageBuffer: Buffer,
    filename = 'frame.jpg',
    mimetype = 'image/jpeg',
  ): Promise<VisionAnalyzeResult> {
    const form = new FormData();
    form.append('file', imageBuffer, { filename, contentType: mimetype });

    try {
      const { data } = await this.http.post<VisionAnalyzeResult>(
        '/api/v1/faces/analyze',
        form,
        { headers: form.getHeaders() },
      );
      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Se propaga el código del servicio de visión, pero NUNCA su
        // cuerpo completo: podría contener datos del análisis.
        const status = error.response?.status ?? 503;
        const message =
          (error.response?.data as { message?: string })?.message ??
          'El servicio de visión no está disponible';
        this.logger.error(`Vision Service respondió ${status}: ${message}`);
        throw new HttpException(message, status);
      }
      throw error;
    }
  }

  async health(): Promise<{ status: string; embeddingModel: string; embeddingDim: number }> {
    const { data } = await this.http.get('/api/v1/health', { timeout: 3000 });
    return data;
  }
}
