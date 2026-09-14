import { NotFoundException } from '@nestjs/common';

import { LogbookService } from './logbook.service';

/**
 * Cerrar una incidencia pendiente.
 *
 * LO QUE ESTO PROTEGE NO ES EL BOTON
 * ──────────────────────────────────
 * Son dos reglas del dominio que, si se rompen, no dan error visible:
 *
 *  · **La incidencia NO se toca.** Vive dentro de un parte firmado, y
 *    un parte firmado no se edita (ADR 0012). Cerrarla escribe una
 *    resolucion que la referencia. Si alguien "simplificara" esto a un
 *    `update` sobre `incidents`, todo seguiria funcionando en pantalla
 *    y el registro habria dejado de ser un registro.
 *
 *  · **Cerrar dos veces no es un error.** Dos personas entrando al
 *    turno pueden pulsar el boton en el mismo segundo, y quien tiene
 *    mala cobertura lo pulsa dos veces. La restriccion unica de la base
 *    de datos impide la fila duplicada; lo que se prueba aqui es que el
 *    servicio trate ese choque como exito en vez de decirle a alguien
 *    que fallo algo que salio bien.
 *
 * Se prueba con dobles de Prisma, sin base de datos: lo que puede estar
 * mal aqui es QUE se escribe y COMO se reacciona, no si PostgreSQL
 * cumple una restriccion unica.
 */

type Doble = {
  incident: { findUnique: jest.Mock };
  incidentResolution: { create: jest.Mock; findUnique: jest.Mock };
};

const ACTOR = {
  personId: '418518ee-8014-460b-a66a-f8cb912c0667',
  personName: 'diego ossa',
};
const INCIDENCIA = '29295300-4dca-44d7-a93f-b4646a3d1420';

function construir(prisma: Partial<Doble>) {
  const completo = {
    incident: { findUnique: jest.fn() },
    incidentResolution: { create: jest.fn(), findUnique: jest.fn() },
    ...prisma,
  };
  // El cliente de accesos no interviene al cerrar: solo se usa al
  // firmar, para congelar el cruce.
  const servicio = new LogbookService(
    completo as never,
    { snapshot: jest.fn() } as never,
  );
  return { servicio, prisma: completo };
}

describe('LogbookService.resolve', () => {
  it('escribe una resolucion y NO toca la incidencia', async () => {
    const { servicio, prisma } = construir({
      incident: {
        findUnique: jest.fn().mockResolvedValue({
          id: INCIDENCIA,
          resolution: null,
        }),
      },
      incidentResolution: {
        create: jest.fn().mockResolvedValue({ id: 'r-1', ...ACTOR }),
        findUnique: jest.fn(),
      },
    });

    const salida = await servicio.resolve(ACTOR, INCIDENCIA, 'Ya funciona');

    expect(salida.alreadyResolved).toBe(false);
    expect(prisma.incidentResolution.create).toHaveBeenCalledWith({
      data: {
        incidentId: INCIDENCIA,
        personId: ACTOR.personId,
        personName: ACTOR.personName,
        note: 'Ya funciona',
      },
    });
    // La prueba de verdad: sobre `incident` solo se ha leido.
    expect(
      (prisma.incident as unknown as Record<string, unknown>).update,
    ).toBeUndefined();
  });

  it('guarda QUIEN la cerro, que es lo que la hace un registro', async () => {
    const { servicio, prisma } = construir({
      incident: {
        findUnique: jest.fn().mockResolvedValue({ id: INCIDENCIA, resolution: null }),
      },
      incidentResolution: {
        create: jest.fn().mockResolvedValue({ id: 'r-1' }),
        findUnique: jest.fn(),
      },
    });

    await servicio.resolve(ACTOR, INCIDENCIA);

    const escrito = prisma.incidentResolution.create.mock.calls[0][0].data;
    expect(escrito.personId).toBe(ACTOR.personId);
    expect(escrito.personName).toBe(ACTOR.personName);
  });

  it('una nota vacia se guarda como ausente, no como cadena vacia', async () => {
    const { servicio, prisma } = construir({
      incident: {
        findUnique: jest.fn().mockResolvedValue({ id: INCIDENCIA, resolution: null }),
      },
      incidentResolution: {
        create: jest.fn().mockResolvedValue({ id: 'r-1' }),
        findUnique: jest.fn(),
      },
    });

    await servicio.resolve(ACTOR, INCIDENCIA, '   ');

    expect(prisma.incidentResolution.create.mock.calls[0][0].data.note).toBeNull();
  });

  it('CERRAR DOS VECES NO ES UN ERROR', async () => {
    // Ya estaba cerrada cuando se leyo. Se devuelve la resolucion que
    // existe y no se escribe nada.
    const existente = { id: 'r-1', personName: 'otra persona' };
    const { servicio, prisma } = construir({
      incident: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: INCIDENCIA, resolution: existente }),
      },
    });

    const salida = await servicio.resolve(ACTOR, INCIDENCIA);

    expect(salida.alreadyResolved).toBe(true);
    expect(salida.resolution).toBe(existente);
    expect(prisma.incidentResolution.create).not.toHaveBeenCalled();
  });

  it('LA CARRERA TAMBIEN SE TRATA COMO EXITO', async () => {
    // Alguien la cerro ENTRE la lectura y la escritura. La
    // comprobacion previa no puede evitarlo -entre leer y escribir cabe
    // otra peticion- asi que el choque de la restriccion unica tiene que
    // resolverse aqui. Es el caso que una comprobacion previa a solas
    // deja pasar y que nadie descubre hasta que dos personas entran al
    // turno a la vez.
    const existente = { id: 'r-1', personName: 'quien llego antes' };
    const { servicio } = construir({
      incident: {
        findUnique: jest.fn().mockResolvedValue({ id: INCIDENCIA, resolution: null }),
      },
      incidentResolution: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        findUnique: jest.fn().mockResolvedValue(existente),
      },
    });

    const salida = await servicio.resolve(ACTOR, INCIDENCIA);

    expect(salida.alreadyResolved).toBe(true);
    expect(salida.resolution).toBe(existente);
  });

  it('un fallo que NO es la restriccion unica se propaga', async () => {
    // Tragarse cualquier error aqui haria que la interfaz dijera
    // «cerrada» con la base de datos caida, y la incidencia
    // reaparecería en la siguiente carga sin que nadie entienda por que.
    const { servicio } = construir({
      incident: {
        findUnique: jest.fn().mockResolvedValue({ id: INCIDENCIA, resolution: null }),
      },
      incidentResolution: {
        create: jest.fn().mockRejectedValue(new Error('conexion perdida')),
        findUnique: jest.fn(),
      },
    });

    await expect(servicio.resolve(ACTOR, INCIDENCIA)).rejects.toThrow(
      'conexion perdida',
    );
  });

  it('una incidencia que no existe da 404', async () => {
    const { servicio } = construir({
      incident: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    await expect(servicio.resolve(ACTOR, INCIDENCIA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
