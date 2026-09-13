import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AccessClient } from '../access/access.client';
import { PrismaService } from '../prisma/prisma.service';
import { businessDateSafe } from './business-date';
import type { HandoverInput } from './handover.contract';

/**
 * La bitácora de relevo de turno.
 *
 * FIRMAR ES LA UNICA ESCRITURA QUE EXISTE
 * ───────────────────────────────────────
 * No hay actualizar ni borrar, y no es un descuido. Un parte es el
 * testimonio de alguien sobre un turno: si se pudiera editar después,
 * nadie que lo lea podría saber si es lo que se declaró. Una corrección
 * es un parte NUEVO que apunta al anterior, y los dos quedan.
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
   */
  async pending(params: { siteId?: string; days?: number; take?: number }) {
    const dias = Math.min(Math.max(params.days ?? 7, 1), 90);
    const desde = new Date(Date.now() - dias * 24 * 3600 * 1000);

    const incidencias = await this.prisma.incident.findMany({
      where: {
        requiresFollowUp: true,
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
}
