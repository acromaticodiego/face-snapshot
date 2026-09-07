import { z } from 'zod';
import { PersonStatusSchema } from './common.contract';

/**
 * Contrato del Face Service (NestJS + Prisma).
 * Dueño único de las entidades `persons` y `face_embeddings`.
 */

/** Vista pública de una persona. Sin datos biométricos. */
export const PersonSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  externalId: z.string().nullable(),
  status: PersonStatusSchema,
  /** Cuántos rostros tiene enrolados. NUNCA los vectores. */
  enrolledFacesCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Person = z.infer<typeof PersonSchema>;

export const CreatePersonSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  externalId: z.string().trim().min(1).max(64).optional(),
});
export type CreatePersonDto = z.infer<typeof CreatePersonSchema>;

export const UpdatePersonSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  status: PersonStatusSchema.optional(),
});
export type UpdatePersonDto = z.infer<typeof UpdatePersonSchema>;

/** Resultado de enrolar un rostro (multipart con la imagen). */
export const EnrollFaceResponseSchema = z.object({
  personId: z.string().uuid(),
  faceId: z.string().uuid(),
  detectionScore: z.number(),
  enrolledFacesCount: z.number().int(),
  message: z.string(),
});
export type EnrollFaceResponse = z.infer<typeof EnrollFaceResponseSchema>;

/**
 * Resultado de identificar un embedding contra la base.
 * Uso interno: Face Service → Access Service.
 */
export const IdentifyMatchSchema = z.object({
  personId: z.string().uuid(),
  fullName: z.string(),
  status: PersonStatusSchema,
  /** Similitud coseno 0..1. Más alto = más parecido. */
  similarity: z.number(),
});
export type IdentifyMatch = z.infer<typeof IdentifyMatchSchema>;

export const IdentifyResponseSchema = z.object({
  match: IdentifyMatchSchema.nullable(),
  /** Similitud del mejor candidato aunque no supere el umbral. */
  bestSimilarity: z.number(),
  candidatesEvaluated: z.number().int(),
});
export type IdentifyResponse = z.infer<typeof IdentifyResponseSchema>;
