/**
 * Día al que se imputa un parte, en la hora local de la sede.
 *
 * MISMA CONVENCION QUE LA JORNADA, Y NO POR CASUALIDAD
 * ────────────────────────────────────────────────────
 * `shift_svc` imputa una jornada al día LOCAL de la sede: un turno de
 * noche que empieza el lunes a las 22:00 es la jornada del lunes. Si la
 * bitácora usara otra convención, cruzar el parte de un turno con su
 * jornada daría días distintos y nadie entendería por qué.
 *
 * POR QUE ESTA FUNCION ESTA DUPLICADA Y NO COMPARTIDA
 * ──────────────────────────────────────────────────
 * Es la misma que `businessDateOf` en el Shift Service. El ADR 0008
 * retiró el paquete compartido porque compartir código entre
 * microservicios acopla despliegues, y quince líneas sin dependencias
 * no valen ese precio. Lo que sí es un contrato —la convención de que
 * el día es el local de la sede— está escrito en los dos sitios.
 *
 * `Intl.DateTimeFormat` con `timeZone` hace la conversión correcta,
 * cambios de horario de verano incluidos, sin dependencias. Usar
 * `getDate()` tomaría la zona del servidor, que en un contenedor es
 * UTC: en Bogotá (UTC-5), todo lo firmado después de las 19:00 se
 * imputaría al día siguiente.
 */
export function businessDateOf(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);

  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const date = `${value('year')}-${value('month')}-${value('day')}`;
  if (date.length !== 10) {
    throw new Error(`Zona horaria no reconocida: ${timezone}`);
  }
  return date;
}

/**
 * La misma cuenta, pero sin poder fallar.
 *
 * Si el Access Service no respondió al firmar, no se sabe la zona
 * horaria de la sede y hay que imputar el parte a algún día de todas
 * formas. Se usa UTC y se sigue adelante: **un parte con el día
 * posiblemente corrido es preferible a no tener parte**, que es la
 * misma dirección de fallo que el resto del servicio.
 *
 * Devuelve además qué zona se acabó usando, para que quien guarde el
 * registro pueda decir en el log que fue una suposición.
 */
export function businessDateSafe(
  at: Date,
  timezone: string | null | undefined,
): { date: string; timezoneUsed: string; assumed: boolean } {
  if (timezone) {
    try {
      return {
        date: businessDateOf(at, timezone),
        timezoneUsed: timezone,
        assumed: false,
      };
    } catch {
      // Una zona horaria que Intl no reconoce no puede tumbar la firma
      // de un parte.
    }
  }

  return { date: businessDateOf(at, 'UTC'), timezoneUsed: 'UTC', assumed: true };
}
