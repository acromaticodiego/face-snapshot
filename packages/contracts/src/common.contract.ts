import { z } from 'zod';

/**
 * Caja delimitadora en píxeles, relativa a la imagen ORIGINAL enviada
 * por el cliente (no a la imagen redimensionada internamente).
 * El frontend la dibuja directamente sobre el vídeo.
 */
export const BoundingBoxSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/** Formato uniforme de error en todos los servicios. */
export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
  code: z.string().optional(),
  timestamp: z.string(),
  path: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Motivo por el que se concedió o denegó el acceso. Alimenta la auditoría. */
export const AccessReasonSchema = z.enum([
  'GRANTED',
  'BELOW_THRESHOLD',
  'NO_FACE_DETECTED',
  'MULTIPLE_FACES',
  'LOW_QUALITY',
  'INSUFFICIENT_VOTES',
  'PERSON_SUSPENDED',
]);
export type AccessReason = z.infer<typeof AccessReasonSchema>;

export const PersonStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export type PersonStatus = z.infer<typeof PersonStatusSchema>;
