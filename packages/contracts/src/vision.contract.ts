import { z } from 'zod';
import { BoundingBoxSchema } from './common.contract';

/**
 * Contrato del Vision Service (Python/FastAPI).
 *
 * IMPORTANTE: el Vision Service NO tiene estado y NO conoce identidades.
 * Convierte píxeles en vectores. Quien decide "quién es" es Face Service.
 */

/** Un rostro detectado, con su embedding. */
export const DetectedFaceSchema = z.object({
  bbox: BoundingBoxSchema,
  /** Confianza del detector (rostros.pt). 0..1 */
  detectionScore: z.number().min(0).max(1),
  /**
   * Embedding ArcFace de 512 dimensiones, normalizado L2.
   * ⚠️ NUNCA debe viajar hasta el frontend. Solo circula entre
   * Vision Service → Face Service.
   */
  embedding: z.array(z.number()).length(512),
  /** Métricas de calidad; permiten descartar capturas malas. */
  quality: z.object({
    faceWidthPx: z.number().int(),
    faceHeightPx: z.number().int(),
    /** Varianza del laplaciano: valores bajos = imagen borrosa. */
    blurScore: z.number(),
    /** true si el rostro toca el borde de la imagen (posible recorte). */
    truncated: z.boolean(),
  }),
});
export type DetectedFace = z.infer<typeof DetectedFaceSchema>;

/** Respuesta de POST /api/v1/faces/analyze */
export const VisionAnalyzeResponseSchema = z.object({
  faces: z.array(DetectedFaceSchema),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  processingTimeMs: z.number(),
  modelInfo: z.object({
    detector: z.string(),
    detectorVersion: z.string(),
    embedder: z.string(),
    embedderVersion: z.string(),
  }),
});
export type VisionAnalyzeResponse = z.infer<typeof VisionAnalyzeResponseSchema>;

/** Rostro sin embedding: para previsualización en el frontend. */
export const VisionDetectOnlyResponseSchema = z.object({
  faces: z.array(
    z.object({
      bbox: BoundingBoxSchema,
      detectionScore: z.number().min(0).max(1),
    }),
  ),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  processingTimeMs: z.number(),
});
export type VisionDetectOnlyResponse = z.infer<typeof VisionDetectOnlyResponseSchema>;
