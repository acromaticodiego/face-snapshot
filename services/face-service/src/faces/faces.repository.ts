import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Acceso a los vectores faciales.
 *
 * Toda la interacción con la columna `embedding` pasa por aquí, porque
 * Prisma no expone el tipo `vector` en el cliente tipado y hay que usar
 * SQL crudo. Concentrarlo en un único repositorio significa que existe
 * un solo sitio en toda la base de código donde un embedding puede
 * entrar o salir de la base de datos.
 */
@Injectable()
export class FacesRepository {
  private readonly logger = new Logger(FacesRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Serializa un vector al literal que espera pgvector: '[0.1,0.2,...]'.
   *
   * Se valida el contenido numérico antes de construir el literal. Aunque
   * el valor viaja siempre como parámetro (nunca concatenado en el SQL),
   * un NaN o un Infinity produciría un error opaco en la base de datos.
   */
  private toVectorLiteral(embedding: number[], expectedDim: number): string {
    if (embedding.length !== expectedDim) {
      throw new Error(
        `Dimensión de embedding inválida: ${embedding.length}, se esperaba ${expectedDim}`,
      );
    }
    for (const value of embedding) {
      if (!Number.isFinite(value)) {
        throw new Error('El embedding contiene valores no finitos');
      }
    }
    return `[${embedding.join(',')}]`;
  }

  /** Guarda un vector facial asociado a una persona. */
  async insertEmbedding(params: {
    personId: string;
    embedding: number[];
    modelName: string;
    modelVersion: string;
    detScore: number;
    expectedDim: number;
  }): Promise<string> {
    const literal = this.toVectorLiteral(params.embedding, params.expectedDim);

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO face_svc.face_embeddings
        (id, person_id, embedding, model_name, model_version, det_score, created_at)
      VALUES
        (gen_random_uuid(), ${params.personId}::uuid, ${literal}::vector,
         ${params.modelName}, ${params.modelVersion}, ${params.detScore}, NOW())
      RETURNING id::text
    `;

    return rows[0].id;
  }

  /**
   * Busca las personas más parecidas a un vector.
   *
   * El operador `<=>` de pgvector devuelve DISTANCIA coseno; como los
   * embeddings vienen normalizados L2, la similitud es 1 - distancia.
   *
   * Se agrupa por persona quedándose con su mejor coincidencia: alguien
   * con cinco rostros enrolados no debe ocupar los cinco primeros
   * puestos del ranking y desplazar a los demás candidatos.
   *
   * Solo se comparan vectores del MISMO modelo y versión: embeddings de
   * modelos distintos ocupan espacios vectoriales incompatibles y su
   * similitud no significaría nada.
   */
  async findNearest(params: {
    embedding: number[];
    modelName: string;
    modelVersion: string;
    limit: number;
    expectedDim: number;
  }): Promise<
    Array<{
      personId: string;
      fullName: string;
      status: string;
      similarity: number;
    }>
  > {
    const literal = this.toVectorLiteral(params.embedding, params.expectedDim);

    const rows = await this.prisma.$queryRaw<
      Array<{
        person_id: string;
        full_name: string;
        status: string;
        similarity: number;
      }>
    >`
      SELECT
        p.id::text          AS person_id,
        p.full_name         AS full_name,
        p.status::text      AS status,
        MAX(1 - (e.embedding <=> ${literal}::vector)) AS similarity
      FROM face_svc.face_embeddings e
      INNER JOIN face_svc.persons p ON p.id = e.person_id
      WHERE p.deleted_at IS NULL
        AND p.status = 'ACTIVE'
        AND e.model_name = ${params.modelName}
        AND e.model_version = ${params.modelVersion}
      GROUP BY p.id, p.full_name, p.status
      ORDER BY similarity DESC
      LIMIT ${params.limit}
    `;

    return rows.map((r) => ({
      personId: r.person_id,
      fullName: r.full_name,
      status: r.status,
      similarity: Number(r.similarity),
    }));
  }

  async countByPerson(personId: string): Promise<number> {
    return this.prisma.faceEmbedding.count({ where: { personId } });
  }

  /**
   * Borrado físico de los vectores de una persona.
   *
   * No es un borrado suave a propósito: los datos biométricos deben
   * desaparecer de verdad cuando se ejerce el derecho al olvido.
   */
  async deleteAllForPerson(personId: string): Promise<number> {
    const result = await this.prisma.faceEmbedding.deleteMany({
      where: { personId },
    });
    this.logger.log(
      `Eliminados ${result.count} vectores faciales de la persona ${personId}`,
    );
    return result.count;
  }

  async deleteOne(faceId: string): Promise<void> {
    await this.prisma.faceEmbedding.delete({ where: { id: faceId } });
  }
}
