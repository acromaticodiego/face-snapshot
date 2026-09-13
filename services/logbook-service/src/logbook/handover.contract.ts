import { z } from 'zod';

/**
 * La frontera de este servicio: qué se acepta al firmar un parte.
 *
 * Se declara aquí y se valida con zod aunque quien llame sea el
 * Gateway, que es código propio. El ADR 0008 explica por qué: el tipo
 * de TypeScript no vale nada al otro lado de la red, y estos dos
 * procesos se despliegan por separado. Un campo que desaparece tiene
 * que dar un error claro al recibirlo, no un `undefined` que acabe
 * guardado como el testimonio de alguien.
 */

/** Cuánto puede abarcar un parte. Un turno no dura más que esto. */
export const MAX_COBERTURA_MS = 24 * 3600 * 1000;

/**
 * Margen que se tolera hacia el futuro en `coversTo`.
 *
 * No es cero porque los relojes del navegador y del servidor no están
 * sincronizados al milisegundo, y rechazar un parte por dos segundos de
 * desfase sería absurdo. No es generoso porque un parte que dice cubrir
 * hasta mañana no es un parte.
 */
export const MARGEN_FUTURO_MS = 5 * 60 * 1000;

export const IncidentSchema = z.object({
  title: z.string().trim().min(1).max(160),
  category: z.enum(['ACCESO', 'ALARMA', 'MANTENIMIENTO', 'SEGURIDAD', 'OTRO']),
  severity: z.enum(['BAJA', 'MEDIA', 'ALTA']),

  /// La hora tal y como se dijo. Texto libre corto a propósito: aquí no
  /// se normaliza nada (ver el schema de Prisma).
  mentionedTime: z.string().trim().max(60).optional(),

  requiresFollowUp: z.boolean(),

  /**
   * De dónde salió.
   *
   * Lo declara el cliente porque es el único que lo sabe: el servidor
   * no ve la propuesta original ni lo que la persona tocó antes de
   * firmar. Es una afirmación del autor, igual que el resto del parte.
   */
  origin: z.enum([
    'PROPUESTA_ACEPTADA',
    'PROPUESTA_EDITADA',
    'ANADIDA_POR_PERSONA',
  ]),

  quote: z.string().trim().max(4000).optional(),
  quoteVerified: z.boolean().default(false),
});

export const HandoverSchema = z
  .object({
    /**
     * No aparece `personId`: lo pone el Gateway a partir del token de
     * sesión facial, nunca el cuerpo de la petición.
     *
     * Es la misma regla que ya siguen `/home` y los descansos. Si
     * viajara aquí, cualquiera con una sesión válida podría firmar un
     * parte a nombre de otro, que es exactamente lo que un libro de
     * registro no puede permitir.
     */
    siteId: z.string().uuid(),

    coversFrom: z.iso.datetime({ offset: true }),
    coversTo: z.iso.datetime({ offset: true }),

    source: z.enum(['DICTADO', 'ESCRITO']),

    transcript: z.string().trim().max(50_000).optional(),
    summary: z.string().trim().min(1).max(10_000),

    transcriptionModel: z.string().trim().max(60).optional(),
    structuringModel: z.string().trim().max(60).optional(),

    correctsEntryId: z.string().uuid().optional(),

    /**
     * Un parte SIN incidencias es válido y corriente: la mayoría de los
     * turnos no tienen ninguna. Obligar a que haya al menos una
     * empujaría a inventarse uno, que es justo lo contrario de lo que
     * se busca.
     */
    incidents: z.array(IncidentSchema).max(100).default([]),
  })
  .refine((parte) => new Date(parte.coversTo) > new Date(parte.coversFrom), {
    message: 'coversTo debe ser posterior a coversFrom',
    path: ['coversTo'],
  })
  .refine(
    (parte) =>
      new Date(parte.coversTo).getTime() - new Date(parte.coversFrom).getTime() <=
      MAX_COBERTURA_MS,
    { message: 'Un parte no puede cubrir más de 24 horas', path: ['coversTo'] },
  )
  .refine(
    (parte) => new Date(parte.coversTo).getTime() <= Date.now() + MARGEN_FUTURO_MS,
    { message: 'Un parte no puede cubrir el futuro', path: ['coversTo'] },
  )
  .refine(
    (parte) => parte.source !== 'DICTADO' || Boolean(parte.transcript?.trim()),
    {
      // Un parte marcado como dictado sin transcripción sería una
      // contradicción: diría que hubo audio y no dejaría rastro de lo
      // que se dijo, que es la parte que zanja las discusiones.
      message: 'Un parte DICTADO tiene que traer su transcripción',
      path: ['transcript'],
    },
  );

export type HandoverInput = z.infer<typeof HandoverSchema>;
export type IncidentInput = z.infer<typeof IncidentSchema>;
