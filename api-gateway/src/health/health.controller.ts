import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  AccessServiceClient,
  FaceServiceClient,
} from '../proxy/service-clients';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly faces: FaceServiceClient,
    private readonly access: AccessServiceClient,
  ) {}

  /**
   * Estado agregado del sistema.
   *
   * Consulta los servicios en paralelo: si uno está caído, el health
   * check no debe tardar la suma de todos los tiempos de espera.
   */
  @Get()
  @ApiOperation({ summary: 'Estado de todos los servicios' })
  async check() {
    const [face, access] = await Promise.allSettled([
      this.faces.health(),
      this.access.health(),
    ]);

    const faceOk = face.status === 'fulfilled';
    const accessOk = access.status === 'fulfilled';

    return {
      status: faceOk && accessOk ? 'ok' : 'degraded',
      service: 'api-gateway',
      services: {
        faceService: faceOk ? (face.value as any) : { status: 'unreachable' },
        accessService: accessOk
          ? (access.value as any)
          : { status: 'unreachable' },
      },
      timestamp: new Date().toISOString(),
    };
  }
}
