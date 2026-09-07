import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../prisma/prisma.service';
import { VisionClient } from '../vision/vision.client';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vision: VisionClient,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio y sus dependencias' })
  async check() {
    const [database, visionStatus] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.vision.health(),
    ]);

    const dbOk = database.status === 'fulfilled';
    const visionOk = visionStatus.status === 'fulfilled';

    return {
      status: dbOk && visionOk ? 'ok' : 'degraded',
      service: 'face-service',
      dependencies: {
        database: dbOk ? 'ok' : 'unreachable',
        visionService: visionOk ? 'ok' : 'unreachable',
      },
      ...(visionOk
        ? { embeddingModel: (visionStatus.value as any).embeddingModel }
        : {}),
    };
  }
}
