import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio' })
  async check() {
    const database = await this.prisma
      .$queryRaw`SELECT 1`
      .then(() => 'ok')
      .catch(() => 'unreachable');

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'access-service',
      dependencies: { database },
    };
  }
}
