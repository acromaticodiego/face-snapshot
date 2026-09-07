import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma del Access Service (schema `access_svc`).
 *
 * Usa un rol de base de datos distinto al del Face Service: PostgreSQL
 * impide por permisos que este servicio lea la tabla de vectores
 * faciales, aunque su código lo intentase.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.ACCESS_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'ACCESS_DATABASE_URL no está definida. Copia .env.example a .env.',
      );
    }

    super({
      adapter: new PrismaPg({ connectionString }),
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conectado a PostgreSQL (schema access_svc)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
