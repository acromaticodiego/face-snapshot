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

    // El Access Service NO cuenta para este estado, al contrario que
    // Redis en el Shift Service. La diferencia es qué deja de funcionar
    // sin él: sin bus, la jornada no avanza y ese servicio no cumple su
    // razón de ser; sin Access Service, un parte se firma igual y solo
    // pierde el cruce con los registros de puerta.
    //
    // Marcarse como enfermo por una dependencia opcional haría que
    // Docker reiniciara este contenedor cada vez que un vecino va
    // lento, sin arreglar nada.
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'logbook-service',
      dependencies: { database },
    };
  }
}
