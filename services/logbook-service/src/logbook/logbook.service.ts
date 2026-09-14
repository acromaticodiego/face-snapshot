import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AccessClient } from '../access/access.client';
import { PrismaService } from '../prisma/prisma.service';
import { businessDateSafe } from './business-date';
import type { HandoverInput } from './handover.contract';

/**
 * La bitácora de relevo de turno.
 *
 * TODO SE ESCRIBE AÑADIENDO, NUNCA MODIFICANDO
 * ────────────────────────────────────────────
 * No hay actualizar ni borrar, y no es un descuido. Un parte es el
 * testimonio de alguien sobre un turno: si se pudiera editar después,
 * nadie que lo lea podría saber si es lo que se declaró. Una corrección
 * es un parte NUEVO que apunta al anterior, y los dos quedan.
 *
 * Cerrar una incidencia sigue exactamente la misma regla. No se marca
 * la incidencia como cerrada —está dentro de un parte firmado— sino que
 * se escribe una resolución que la referencia. Así el parte sigue
 * diciendo lo que decía, y además se puede responder quién la cerró y
 * cuándo.
 */
@Injectable()
export class LogbookService {
  private readonly logger = new Logger(LogbookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessClient,
  ) {}

  /**
   * Firma un parte.
   *
   * El orden importa: primero se pide el cruce de accesos, que puede
   * fallar sin consecuencias, y después se escribe. Al revés habría que
   * decidir qué hacer con un parte ya guardado al que le falta el
   * cruce, y eso sería un estado a medias que nadie limpia.
   */
  async sign(author: { personId: string; personName: string }, parte: HandoverInput) {
    const desde = new Date(parte.coversFrom);
    const hasta = new Date(parte.coversTo);

    if (parte.correctsEntryId) {
      // Se comprueba que el parte corregido existe. Un puntero a un
      // identificador inventado convertiría la cadena de correcciones
      // en algo que no se puede seguir, que es justo lo que da valor a
      // corregir sin borrar.
      const previo = await this.prisma.handoverEntry.findUnique({
        where: { id: parte.correctsEntryId },
        select: { id: true },
      });
      if (!previo) {
        throw new NotFoundException('El parte que se pretende corregir no existe');
      }
    }

    const cruce = await this.access.windowSummary({
      from: desde.toISOString(),
      to: hasta.toISOString(),
      siteId: parte.siteId,
    });

    // El día se calcula sobre el INICIO del periodo cubierto, no sobre
    // el momento de firmar: un turno de noche se firma de madrugada, y
    // con la hora de la firma acabaría imputado al día siguiente.
    const dia = businessDateSafe(desde, cruce?.site?.timezone);
    if (dia.assumed) {
      this.logger.warn(
        `Parte imputado al día ${dia.date} en UTC: no se pudo resolver la ` +
          `zona horaria de la sede ${parte.siteId}`,
      );
    }

    return this.prisma.handoverEntry.create({
      data: {
        personId: author.personId,
        personName: author.personName,
        siteId: parte.siteId,
        // El nombre de la sede sale del Access Service, que es su
        // dueño, y no del cuerpo de la petición: es un dato que se
        // desnormaliza para que el parte siga siendo legible dentro de
        // dos años, no algo que declare quien firma.
        siteName: cruce?.site?.name ?? null,
        businessDate: new Date(`${dia.date}T00:00:00Z`),
        coversFrom: desde,
        coversTo: hasta,
        source: parte.source,
        transcript: parte.transcript ?? null,
        summary: parte.summary,
        transcriptionModel: parte.transcriptionModel ?? null,
        structuringModel: parte.structuringModel ?? null,
        // El cruce se guarda como JSON tal cual. La conversion es
        // necesaria porque Prisma exige una forma indexable y este
        // objeto tiene una interfaz declarada, que es justo lo que se
        // quiere al leerlo desde el cliente del Access Service.
        accessSnapshot: (cruce ?? undefined) as Prisma.InputJsonValue | undefined,
        correctsEntryId: parte.correctsEntryId ?? null,
        incidents: {
          create: parte.incidents.map((incidencia) => ({
            title: incidencia.title,
            category: incidencia.category,
            severity: incidencia.severity,
            mentionedTime: incidencia.mentionedTime ?? null,
            requiresFollowUp: incidencia.requiresFollowUp,
            origin: incidencia.origin,
            quote: incidencia.quote ?? null,
            quoteVerified: incidencia.quoteVerified,
          })),
        },
      },
      include: { incidents: true },
    });
  }

  async findOne(id: string) {
    const parte = await this.prisma.handoverEntry.findUnique({
      where: { id },
      include: { incidents: { orderBy: { createdAt: 'asc' } } },
    });
    if (!parte) throw new NotFoundException('No existe ese parte');
    return parte;
  }

  async findMany(params: {
    personId?: string;
    siteId?: string;
    from?: Date;
    to?: Date;
    skip?: number;
    take?: number;
  }) {
    const where = {
      ...(params.personId ? { personId: params.personId } : {}),
      ...(params.siteId ? { siteId: params.siteId } : {}),
      ...(params.from || params.to
        ? {
            coversFrom: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.handoverEntry.findMany({
        where,
        orderBy: { coversTo: 'desc' },
        skip: params.skip ?? 0,
        take: Math.min(params.take ?? 20, 100),
        include: { incidents: { orderBy: { createdAt: 'asc' } } },
      }),
      this.prisma.handoverEntry.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Lo que queda pendiente para quien entra al turno.
   *
   * ES LA CONSULTA QUE JUSTIFICA TODO ESTO. Una bitácora que solo se
   * pudiera leer parte por parte obligaría a repasar el turno anterior
   * entero para enterarse de que el ascensor sigue roto. Lo que hace
   * falta al llegar es la lista corta de lo que no está cerrado.
   *
   * La sostiene un índice PARCIAL sobre las incidencias pendientes: son
   * la minoría, y un índice sobre la columna entera indexaría sobre
   * todo las cerradas, que nadie busca.
   *
   * «Pendiente» son DOS condiciones, no una: que el parte la marcara
   * como que requiere seguimiento, y que nadie la haya cerrado todavía.
   * Sin la segunda, esta lista solo crece: el ascensor roto de hace tres
   * meses le seguiría apareciendo a quien entra mañana, y una lista que
   * nadie puede vaciar acaba siendo una que nadie lee.
   */
  async pending(params: { siteId?: string; days?: number; take?: number }) {
    const dias = Math.min(Math.max(params.days ?? 7, 1), 90);
    const desde = new Date(Date.now() - dias * 24 * 3600 * 1000);

    const incidencias = await this.prisma.incident.findMany({
      where: {
        requiresFollowUp: true,
        resolution: null,
        entry: {
          coversTo: { gte: desde },
          ...(params.siteId ? { siteId: params.siteId } : {}),
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: Math.min(params.take ?? 50, 200),
      include: {
        entry: {
          select: {
            id: true,
            personName: true,
            siteName: true,
            businessDate: true,
            coversFrom: true,
            coversTo: true,
          },
        },
      },
    });

    return { items: incidencias, total: incidencias.length, sinceDays: dias };
  }

  /**
   * Cierra una incidencia: la saca de la lista de pendientes.
   *
   * NO TOCA LA INCIDENCIA. Escribe una resolución que la referencia, por
   * el mismo motivo que un parte se corrige con otro parte y no
   * editándolo. Ver el modelo `IncidentResolution`.
   *
   * ES IDEMPOTENTE, Y ESO NO ES UNA COMODIDAD
   * ─────────────────────────────────────────
   * Dos personas entrando al turno pueden pulsar el botón en el mismo
   * segundo, y quien lo pulsa con mala cobertura lo pulsa dos veces. La
   * restricción única de la base de datos impide la segunda fila, y
   * aquí ese choque se trata como ÉXITO devolviendo la resolución que ya
   * existe: el trabajo estaba hecho, y responder un error haría que la
   * interfaz dijera que falló algo que salió bien.
   *
   * Quien cierra no tiene por qué ser quien la abrió. Es deliberado y es
   * lo que un relevo de turno significa: el del turno siguiente es
   * precisamente quien puede comprobar que el ascensor ya funciona. Por
   * eso queda escrito quién fue.
   */
  async resolve(
    actor: { personId: string; personName: string },
    incidentId: string,
    note?: string,
  ) {
    const incidencia = await this.prisma.incident.findUnique({
      where: { id: incidentId },
      include: { resolution: true },
    });

    if (!incidencia) {
      throw new NotFoundException('Esa incidencia no existe');
    }

    if (incidencia.resolution) {
      this.logger.log(
        `Incidencia ${incidentId} ya estaba cerrada por ` +
          `${incidencia.resolution.personName}`,
      );
      return { resolution: incidencia.resolution, alreadyResolved: true };
    }

    try {
      const resolution = await this.prisma.incidentResolution.create({
        data: {
          incidentId,
          personId: actor.personId,
          personName: actor.personName.slice(0, 120),
          note: note?.trim() ? note.trim().slice(0, 500) : null,
        },
      });

      this.logger.log(
        `Incidencia ${incidentId} cerrada por ${actor.personName}`,
      );
      return { resolution, alreadyResolved: false };
    } catch (error) {
      // P2002 es la restricción única: alguien la cerró entre el
      // `findUnique` de arriba y este `create`. La comprobación previa
      // no puede evitarlo —entre leer y escribir cabe otra petición— y
      // por eso el caso se resuelve aquí en vez de fingir que no existe.
      if ((error as { code?: string }).code !== 'P2002') throw error;

      const resolution = await this.prisma.incidentResolution.findUnique({
        where: { incidentId },
      });
      return { resolution, alreadyResolved: true };
    }
  }
}
