import { z } from 'zod';

/**
 * Lee un evento del bus y comprueba que es lo que dice ser.
 *
 * POR QUE SE VALIDA ALGO QUE PRODUCE UN SERVICIO PROPIO
 * ─────────────────────────────────────────────────────
 * Porque el bus es una frontera entre procesos que se despliegan por
 * separado. En cuanto una versión nueva del Access Service publique
 * un campo distinto, este servicio lo recibirá sin haber recompilado
 * nada: el tipo de TypeScript no vale de nada al otro lado de la red.
 *
 * Validar aquí convierte un error de contrato en un mensaje claro en
 * el momento de recibirlo, en vez de en un `undefined` que se propaga
 * y acaba escribiendo una jornada con la hora en blanco.
 */

export const AccessGrantedEventSchema = z.object({
  eventId: z.string().uuid(),
  type: z.literal('AccessGranted'),
  occurredAt: z.string().datetime(),

  personId: z.string().uuid(),
  personName: z.string(),

  siteId: z.string().uuid(),
  siteName: z.string(),
  siteTimezone: z.string(),
  zoneId: z.string().uuid(),
  zoneName: z.string(),
  zoneShiftEffect: z.enum(['WORK', 'BREAK', 'NEUTRAL']),
  accessPointId: z.string().uuid(),
  accessPointName: z.string(),

  direction: z.enum(['IN', 'OUT']),
  stillInsideSite: z.boolean(),
  anomaly: z.enum(['ANTIPASSBACK_SOFT']).nullable(),
});

export type AccessGrantedEvent = z.infer<typeof AccessGrantedEventSchema>;

/**
 * Convierte los campos planos de un mensaje de Redis en un evento.
 *
 * Los streams de Redis entregan pares campo-valor como un array plano
 * `[campo, valor, campo, valor, …]`. El evento viaja entero en el
 * campo `data`, en JSON: así el contrato vive en un solo sitio y
 * añadir un campo no obliga a tocar el transporte.
 *
 * Devuelve `null` en vez de lanzar, porque quien llama necesita poder
 * distinguir "no se entiende, descártalo" de "falló la base de datos,
 * reinténtalo": el primero no debe reintentarse nunca y el segundo
 * siempre.
 */
export function parseAccessGrantedEvent(
  fields: string[],
): AccessGrantedEvent | null {
  const index = fields.indexOf('data');
  if (index === -1 || index + 1 >= fields.length) return null;

  try {
    const parsed: unknown = JSON.parse(fields[index + 1]);
    const result = AccessGrantedEventSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Lee el `traceparent` que el relay metió en el mensaje.
 *
 * POR QUE NO ES PARTE DEL ESQUEMA DE ARRIBA
 * ─────────────────────────────────────────
 * Porque no es parte del evento. Es metadato del TRANSPORTE: describe
 * de qué traza vino este mensaje, no qué ocurrió en la puerta. Si
 * viajara dentro del payload, el validador del contrato tendría que
 * conocerlo y una versión del Access Service sin telemetría rompería
 * el esquema. Viajando en un campo aparte, el contrato del evento no
 * se entera de que existe la observabilidad.
 *
 * Devuelve `null` si el mensaje no lo trae, que es el caso de todo lo
 * publicado con la telemetría apagada y de todo lo anterior a la
 * Fase 4. El consumidor procesa esos eventos igual, sin span: la
 * jornada de alguien no puede depender de que haya trazas.
 */
export function traceparentDelMensaje(fields: string[]): string | null {
  // Redis Streams entrega los campos como una lista PLANA de pares
  // alternos, no como un objeto: hay que recorrerla de dos en dos.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'traceparent' && fields[i + 1]) return fields[i + 1];
  }
  return null;
}
