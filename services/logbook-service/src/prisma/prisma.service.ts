import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma del Logbook Service (schema `logbook_svc`).
 *
 * Rol propio, como el resto de servicios, y aquí el aislamiento importa
 * en una dirección concreta: lo que hace creíble un parte de relevo es
 * que solo puede haberlo escrito quien lo firma. Si otro servicio
 * pudiera insertar filas en estas tablas, esa afirmación se caería.
 * PostgreSQL lo impide por permisos, no por disciplina.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.LOGBOOK_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'LOGBOOK_DATABASE_URL no está definida. Copia .env.example a .env.',
      );
    }

    super({
      adapter: new PrismaPg({ connectionString }),
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conectado a PostgreSQL (schema logbook_svc)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
