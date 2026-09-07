import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma del Face Service (schema `face_svc`).
 *
 * Prisma 7 exige un adaptador de driver explícito: la conexión ya no se
 * declara en el schema, sino que se construye aquí. La consecuencia
 * práctica es que la cadena de conexión solo existe en tiempo de
 * ejecución y nunca aparece en un archivo versionado.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.FACE_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'FACE_DATABASE_URL no está definida. Copia .env.example a .env.',
      );
    }

    super({
      adapter: new PrismaPg({ connectionString }),
      // El nivel 'query' se omite a propósito: las consultas de similitud
      // llevan el embedding completo como parámetro y acabaría escrito
      // en los logs.
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conectado a PostgreSQL (schema face_svc)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
