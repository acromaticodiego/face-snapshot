import { businessDateOf, businessDateSafe } from './business-date';
import { HandoverSchema } from './handover.contract';

/**
 * Lo que se prueba, y por qué eso.
 *
 * Este servicio guarda el testimonio de una persona sobre un turno, y
 * lo guarda para siempre sin poder editarlo. Las dos cosas que hay que
 * blindar son, por tanto, **qué se deja entrar** y **a qué día se
 * imputa**: una vez firmado, un parte mal validado ya no se arregla.
 *
 * Todo lo de aquí es lógica pura: sin base de datos y sin contenedores.
 */

const AHORA = Date.now();
const hace = (horas: number) => new Date(AHORA - horas * 3600_000).toISOString();

const PARTE_VALIDO = {
  siteId: '11111111-1111-4111-8111-111111111111',
  coversFrom: hace(8),
  coversTo: hace(0.1),
  source: 'ESCRITO' as const,
  summary: 'Turno sin novedades.',
  incidents: [],
};

describe('HandoverSchema', () => {
  it('acepta un parte mínimo y sin incidencias', () => {
    // La mayoría de los turnos no tienen ninguna novedad. Exigir al
    // menos una empujaría a inventarse algo.
    const resultado = HandoverSchema.safeParse(PARTE_VALIDO);
    expect(resultado.success).toBe(true);
    expect(resultado.success && resultado.data.incidents).toEqual([]);
  });

  it('rechaza un periodo invertido', () => {
    const resultado = HandoverSchema.safeParse({
      ...PARTE_VALIDO,
      coversFrom: hace(1),
      coversTo: hace(5),
    });
    expect(resultado.success).toBe(false);
  });

  it('rechaza un parte que cubre más de 24 horas', () => {
    // Un turno no dura más que esto, y un periodo enorme arrastraría
    // un cruce de accesos gigante dentro del registro.
    const resultado = HandoverSchema.safeParse({
      ...PARTE_VALIDO,
      coversFrom: hace(30),
    });
    expect(resultado.success).toBe(false);
  });

  it('rechaza un parte que dice cubrir el futuro', () => {
    const resultado = HandoverSchema.safeParse({
      ...PARTE_VALIDO,
      coversTo: new Date(AHORA + 6 * 3600_000).toISOString(),
    });
    expect(resultado.success).toBe(false);
  });

  it('tolera un desfase pequeño de reloj', () => {
    // El reloj del navegador y el del servidor no están sincronizados
    // al milisegundo, y rechazar un parte por dos segundos sería
    // absurdo.
    const resultado = HandoverSchema.safeParse({
      ...PARTE_VALIDO,
      coversTo: new Date(AHORA + 2_000).toISOString(),
    });
    expect(resultado.success).toBe(true);
  });

  it('exige transcripción cuando el parte dice estar dictado', () => {
    // Diría que hubo audio sin dejar rastro de lo que se dijo, que es
    // justamente la parte que zanja las discusiones.
    const resultado = HandoverSchema.safeParse({
      ...PARTE_VALIDO,
      source: 'DICTADO',
    });
    expect(resultado.success).toBe(false);
  });

  it('acepta un parte dictado con su transcripción', () => {
    const resultado = HandoverSchema.safeParse({
      ...PARTE_VALIDO,
      source: 'DICTADO',
      transcript: 'Relevo del turno de noche, sin novedad.',
      transcriptionModel: 'nova-3',
      structuringModel: 'gemini-3.8-flash',
    });
    expect(resultado.success).toBe(true);
  });

  it('no acepta que el cuerpo diga de quién es el parte', () => {
    // `personId` sale del token en el Gateway. Si se colara por el
    // cuerpo, cualquiera con una sesión válida firmaría a nombre de
    // otro, y un libro de registro no puede permitir eso.
    const resultado = HandoverSchema.safeParse({
      ...PARTE_VALIDO,
      personId: '22222222-2222-4222-8222-222222222222',
    });
    expect(resultado.success).toBe(true);
    expect(resultado.success && 'personId' in resultado.data).toBe(false);
  });

  it('exige que cada incidencia diga de dónde salió', () => {
    const sinOrigen = {
      ...PARTE_VALIDO,
      incidents: [
        {
          title: 'Ascensor con ruido',
          category: 'MANTENIMIENTO',
          severity: 'MEDIA',
          requiresFollowUp: true,
        },
      ],
    };
    expect(HandoverSchema.safeParse(sinOrigen).success).toBe(false);
  });

  it('da por no verificada una cita que no diga lo contrario', () => {
    // El valor por defecto es el prudente: si nadie afirma que la cita
    // estaba respaldada, no lo estaba.
    const resultado = HandoverSchema.safeParse({
      ...PARTE_VALIDO,
      incidents: [
        {
          title: 'Ascensor con ruido',
          category: 'MANTENIMIENTO',
          severity: 'MEDIA',
          requiresFollowUp: true,
          origin: 'ANADIDA_POR_PERSONA',
        },
      ],
    });
    expect(resultado.success).toBe(true);
    expect(resultado.success && resultado.data.incidents[0].quoteVerified).toBe(
      false,
    );
  });

  it('rechaza un resumen vacío', () => {
    expect(
      HandoverSchema.safeParse({ ...PARTE_VALIDO, summary: '   ' }).success,
    ).toBe(false);
  });
});

describe('businessDateOf', () => {
  it('usa la hora local de la sede y no la del servidor', () => {
    // Un turno que empieza el lunes a las 22:00 en Bogotá es del lunes.
    // En UTC ya son las 03:00 del martes: con la zona del contenedor,
    // ese parte se imputaría al día siguiente.
    const lunesNoche = new Date('2026-09-15T03:00:00Z');
    expect(businessDateOf(lunesNoche, 'America/Bogota')).toBe('2026-09-14');
    expect(businessDateOf(lunesNoche, 'UTC')).toBe('2026-09-15');
  });

  it('falla ante una zona horaria que no existe', () => {
    expect(() => businessDateOf(new Date(), 'Marte/Olympus')).toThrow();
  });
});

describe('businessDateSafe', () => {
  it('respeta la zona de la sede cuando se conoce', () => {
    const resultado = businessDateSafe(
      new Date('2026-09-15T03:00:00Z'),
      'America/Bogota',
    );
    expect(resultado).toEqual({
      date: '2026-09-14',
      timezoneUsed: 'America/Bogota',
      assumed: false,
    });
  });

  it('cae a UTC sin fallar cuando no se conoce la zona', () => {
    // Pasa cuando el Access Service no responde al firmar. Un parte con
    // el día posiblemente corrido es preferible a no tener parte.
    const resultado = businessDateSafe(new Date('2026-09-15T03:00:00Z'), null);
    expect(resultado.date).toBe('2026-09-15');
    expect(resultado.assumed).toBe(true);
  });

  it('cae a UTC si la zona de la sede es inválida', () => {
    const resultado = businessDateSafe(
      new Date('2026-09-15T03:00:00Z'),
      'Marte/Olympus',
    );
    expect(resultado.assumed).toBe(true);
    expect(resultado.timezoneUsed).toBe('UTC');
  });
});
