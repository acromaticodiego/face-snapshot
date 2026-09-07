import { z } from 'zod';
import { BoundingBoxSchema, AccessReasonSchema } from './common.contract';

/**
 * Contrato del Access Service (NestJS + Prisma).
 * Es el ÚNICO que decide si se concede el acceso.
 * El frontend jamás toma esta decisión: solo pinta lo que aquí se resuelve.
 */

/** Estado de un rostro individual dentro del frame. */
export const FaceVerdictSchema = z.object({
  bbox: BoundingBoxSchema,
  /** true → caja verde. false → caja roja. */
  recognized: z.boolean(),
  /** Nombre a mostrar, o null si es desconocido. */
  personName: z.string().nullable(),
  personId: z.string().uuid().nullable(),
  /** Similitud 0..1 que se muestra al usuario. */
  confidence: z.number().min(0).max(1),
});
export type FaceVerdict = z.infer<typeof FaceVerdictSchema>;

/**
 * Respuesta de POST /api/v1/auth/verify-frame
 *
 * `authenticated` solo pasa a true cuando se acumulan suficientes
 * coincidencias consecutivas (votación multi-frame). Un único frame
 * afortunado NUNCA concede acceso.
 */
export const VerifyFrameResponseSchema = z.object({
  authenticated: z.boolean(),
  person: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
    })
    .nullable(),
  confidence: z.number().min(0).max(1),
  /** Caja del rostro principal; null si no se detectó ninguno. */
  bbox: BoundingBoxSchema.nullable(),
  /** Todos los rostros del frame, para dibujar varias cajas. */
  faces: z.array(FaceVerdictSchema),
  /**
   * Dimensiones del frame TAL COMO LO ANALIZO el backend.
   *
   * Las cajas vienen en este sistema de coordenadas. El frontend las
   * escala a su tamaño de vídeo con estos valores, en lugar de deducir
   * el factor a partir de su propia lógica de captura: así, si mañana
   * cambia el reescalado, las cajas siguen cuadrando.
   */
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  reason: AccessReasonSchema,
  /** Identificador de la ventana de votación. El cliente lo reenvía. */
  sessionKey: z.string(),
  /** Progreso de la votación: "2 de 3 confirmaciones". */
  votes: z.object({
    current: z.number().int(),
    required: z.number().int(),
  }),
  /** JWT de sesión. Solo presente cuando authenticated === true. */
  accessToken: z.string().optional(),
});
export type VerifyFrameResponse = z.infer<typeof VerifyFrameResponseSchema>;

export const AccessLogSchema = z.object({
  id: z.string().uuid(),
  personId: z.string().uuid().nullable(),
  personName: z.string().nullable(),
  authenticated: z.boolean(),
  confidence: z.number(),
  reason: AccessReasonSchema,
  cameraId: z.string(),
  createdAt: z.string(),
});
export type AccessLog = z.infer<typeof AccessLogSchema>;
