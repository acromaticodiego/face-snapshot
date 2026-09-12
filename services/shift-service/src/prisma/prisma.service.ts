import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma del Shift Service (schema `shift_svc`).
 *
 * Rol propio, como el resto de servicios. Este calcula horas
 * trabajadas y no tiene ningún motivo para poder leer vectores
 * faciales ni hashes de contraseñas; y al revés, que el Access Service
 * no pueda tocar las horas de nadie es lo que hace creíble el registro
 * de jornada. PostgreSQL lo impide por permisos, no por disciplina.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.SHIFT_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'SHIFT_DATABASE_URL no está definida. Copia .env.example a .env.',
      );
    }

    super({
      adapter: new PrismaPg({ connectionString }),
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conectado a PostgreSQL (schema shift_svc)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
