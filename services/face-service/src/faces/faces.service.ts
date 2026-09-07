import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { VisionClient, VisionDetectedFace } from '../vision/vision.client';
import { FacesRepository } from './faces.repository';

export interface IdentifyResult {
  match: {
    personId: string;
    fullName: string;
    status: string;
    similarity: number;
  } | null;
  bestSimilarity: number;
  candidatesEvaluated: number;
}

@Injectable()
export class FacesService {
  private readonly logger = new Logger(FacesService.name);
  private readonly embeddingDim: number;
  private readonly threshold: number;
  private readonly minEnrollScore: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: FacesRepository,
    private readonly vision: VisionClient,
    private readonly config: ConfigService,
  ) {
    this.embeddingDim = Number(this.config.get('EMBEDDING_DIM', 512));
    this.threshold = Number(this.config.get('RECOGNITION_THRESHOLD', 0.38));
    this.minEnrollScore = Number(this.config.get('MIN_ENROLL_SCORE', 0.6));
  }

  /**
   * Extrae EL rostro de una imagen de enrolamiento.
   *
   * Al registrar se exige exactamente un rostro: si aparecen dos, no hay
   * forma de saber cuál es la persona que se pretende dar de alta, y
   * asociar el rostro equivocado a un nombre es un fallo silencioso que
   * después concede accesos indebidos.
   */
  private pickEnrollmentFace(faces: VisionDetectedFace[]): VisionDetectedFace {
    if (faces.length === 0) {
      throw new UnprocessableEntityException(
        'No se detectó ningún rostro en la imagen. Acércate a la cámara y comprueba la iluminación.',
      );
    }
    if (faces.length > 1) {
      throw new UnprocessableEntityException(
        `Se detectaron ${faces.length} rostros. Para registrar debe aparecer una sola persona.`,
      );
    }

    const face = faces[0];
    if (face.detectionScore < this.minEnrollScore) {
      throw new UnprocessableEntityException(
        'La calidad de la captura es insuficiente. Inténtalo de nuevo con mejor luz.',
      );
    }
    if (face.quality.truncated) {
      throw new UnprocessableEntityException(
        'El rostro aparece cortado por el borde. Céntrate en el encuadre.',
      );
    }
    return face;
  }

  /** Registra un rostro y lo asocia a una persona existente. */
  async enroll(
    personId: string,
    imageBuffer: Buffer,
    filename: string,
    mimetype: string,
  ): Promise<{
    personId: string;
    faceId: string;
    detectionScore: number;
    enrolledFacesCount: number;
  }> {
    const person = await this.prisma.person.findFirst({
      where: { id: personId, deletedAt: null },
    });
    if (!person) {
      throw new NotFoundException('La persona no existe');
    }

    const analysis = await this.vision.analyze(imageBuffer, filename, mimetype);
    const face = this.pickEnrollmentFace(analysis.faces);

    if (face.embedding.length !== this.embeddingDim) {
      throw new UnprocessableEntityException(
        `El servicio de visión devolvió un vector de ${face.embedding.length} dimensiones; se esperaban ${this.embeddingDim}`,
      );
    }

    const faceId = await this.repository.insertEmbedding({
      personId,
      embedding: face.embedding,
      modelName: analysis.modelInfo.embedder,
      modelVersion: analysis.modelInfo.embedderVersion,
      detScore: face.detectionScore,
      expectedDim: this.embeddingDim,
    });

    const count = await this.repository.countByPerson(personId);

    // Solo metadatos: ni la imagen ni el vector aparecen en el log.
    this.logger.log(
      `Rostro enrolado para ${personId} (score ${face.detectionScore.toFixed(3)}, total ${count})`,
    );

    return {
      personId,
      faceId,
      detectionScore: face.detectionScore,
      enrolledFacesCount: count,
    };
  }

  /**
   * Identifica a quién pertenece un vector facial.
   *
   * Devuelve la mejor coincidencia SOLO si supera el umbral. Por debajo
   * de él la respuesta es `null`, pero se informa igualmente de la mejor
   * similitud obtenida: el Access Service la usa para explicar por qué
   * se denegó el acceso y permite calibrar el umbral con datos reales.
   */
  async identifyByEmbedding(
    embedding: number[],
    modelName: string,
    modelVersion: string,
  ): Promise<IdentifyResult> {
    if (embedding.length !== this.embeddingDim) {
      throw new BadRequestException(
        `Dimensión de embedding inválida: ${embedding.length}`,
      );
    }

    const candidates = await this.repository.findNearest({
      embedding,
      modelName,
      modelVersion,
      limit: 5,
      expectedDim: this.embeddingDim,
    });

    if (candidates.length === 0) {
      return { match: null, bestSimilarity: 0, candidatesEvaluated: 0 };
    }

    const best = candidates[0];
    const passes = best.similarity >= this.threshold;

    return {
      match: passes ? best : null,
      bestSimilarity: best.similarity,
      candidatesEvaluated: candidates.length,
    };
  }

  /** Analiza una imagen e identifica al titular del rostro principal. */
  async identifyFromImage(
    imageBuffer: Buffer,
    filename: string,
    mimetype: string,
  ): Promise<{
    analysis: Awaited<ReturnType<VisionClient['analyze']>>;
    results: Array<{ face: VisionDetectedFace; identity: IdentifyResult }>;
  }> {
    const analysis = await this.vision.analyze(imageBuffer, filename, mimetype);

    const results = await Promise.all(
      analysis.faces.map(async (face) => ({
        face,
        identity: await this.identifyByEmbedding(
          face.embedding,
          analysis.modelInfo.embedder,
          analysis.modelInfo.embedderVersion,
        ),
      })),
    );

    return { analysis, results };
  }

  async deleteFacesOfPerson(personId: string): Promise<number> {
    return this.repository.deleteAllForPerson(personId);
  }
}
