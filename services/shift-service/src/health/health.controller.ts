import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT, type OptionalRedis } from '../redis/redis.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: OptionalRedis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio' })
  async check() {
    const database = await this.prisma
      .$queryRaw`SELECT 1`
      .then(() => 'ok')
      .catch(() => 'unreachable');

    // Aqui Redis SI cuenta para el estado, al reves que en el Access
    // Service: sin bus, este servicio no recibe eventos y su unica
    // razon de ser -que la jornada avance- deja de cumplirse. Que se
    // note es lo correcto.
    const bus = !this.redis
      ? 'disabled'
      : await this.redis
          .ping()
          .then(() => 'ok')
          .catch(() => 'unreachable');

    const healthy = database === 'ok' && bus === 'ok';

    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'shift-service',
      dependencies: { database, bus },
    };
  }
}
