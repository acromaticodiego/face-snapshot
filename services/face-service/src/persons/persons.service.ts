import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { FacesRepository } from '../faces/faces.repository';
import { PrismaService } from '../prisma/prisma.service';

export interface PersonView {
  id: string;
  fullName: string;
  externalId: string | null;
  status: string;
  enrolledFacesCount: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PersonsService {
  private readonly logger = new Logger(PersonsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly facesRepository: FacesRepository,
  ) {}

  async create(data: {
    fullName: string;
    externalId?: string;
  }): Promise<PersonView> {
    try {
      const person = await this.prisma.person.create({
        data: {
          fullName: data.fullName,
          externalId: data.externalId ?? null,
        },
      });
      this.logger.log(`Persona creada: ${person.id}`);
      return this.toView(person, 0);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `Ya existe una persona con el identificador "${data.externalId}"`,
        );
      }
      throw error;
    }
  }

  async findAll(params: {
    search?: string;
    skip?: number;
    take?: number;
  }): Promise<{ items: PersonView[]; total: number }> {
    const where: Prisma.PersonWhereInput = {
      deletedAt: null,
      ...(params.search
        ? {
            OR: [
              { fullName: { contains: params.search, mode: 'insensitive' } },
              { externalId: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.person.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.skip ?? 0,
        take: Math.min(params.take ?? 50, 200),
        // _count evita una consulta por persona (problema N+1) y, sobre
        // todo, evita traer los vectores para contarlos.
        include: { _count: { select: { embeddings: true } } },
      }),
      this.prisma.person.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toView(r, r._count.embeddings)),
      total,
    };
  }

  async findOne(id: string): Promise<PersonView> {
    const person = await this.prisma.person.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { embeddings: true } } },
    });
    if (!person) {
      throw new NotFoundException('La persona no existe');
    }
    return this.toView(person, person._count.embeddings);
  }

  async update(
    id: string,
    data: { fullName?: string; status?: 'ACTIVE' | 'SUSPENDED' },
  ): Promise<PersonView> {
    await this.findOne(id);
    const person = await this.prisma.person.update({
      where: { id },
      data,
      include: { _count: { select: { embeddings: true } } },
    });
    return this.toView(person, person._count.embeddings);
  }

  /**
   * Elimina a una persona.
   *
   * La ficha se marca como borrada (borrado suave) para no romper la
   * trazabilidad de los accesos históricos, pero sus vectores faciales
   * se eliminan FISICAMENTE. Conservar biometría de alguien que pidió
   * ser eliminado sería indefendible; conservar su nombre en un asiento
   * de auditoría es legítimo y necesario.
   */
  async remove(id: string): Promise<{ deletedEmbeddings: number }> {
    await this.findOne(id);

    const deletedEmbeddings = await this.facesRepository.deleteAllForPerson(id);
    await this.prisma.person.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'SUSPENDED' },
    });

    this.logger.log(
      `Persona ${id} eliminada junto a ${deletedEmbeddings} vectores faciales`,
    );
    return { deletedEmbeddings };
  }

  private toView(person: any, facesCount: number): PersonView {
    return {
      id: person.id,
      fullName: person.fullName,
      externalId: person.externalId,
      status: person.status,
      enrolledFacesCount: facesCount,
      createdAt: person.createdAt.toISOString(),
      updatedAt: person.updatedAt.toISOString(),
    };
  }
}
