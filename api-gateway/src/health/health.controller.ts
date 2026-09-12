import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  AccessServiceClient,
  FaceServiceClient,
  ShiftServiceClient,
} from '../proxy/service-clients';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly faces: FaceServiceClient,
    private readonly access: AccessServiceClient,
    private readonly shifts: ShiftServiceClient,
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
    const [face, access, shift] = await Promise.allSettled([
      this.faces.health(),
      this.access.health(),
      this.shifts.health(),
    ]);

    const unreachable = { status: 'unreachable' };
    const value = (result: PromiseSettledResult<unknown>) =>
      result.status === 'fulfilled' ? result.value : unreachable;

    // El Shift Service NO entra en el estado general.
    //
    // Es una proyección: si se cae, las horas dejan de actualizarse
    // pero las puertas siguen abriéndose y los eventos esperan en la
    // outbox. Marcar el sistema entero como degradado por eso haría
    // que una alerta de nóminas pareciera una avería de seguridad, y
    // acabaría enseñando a ignorarla.
    const healthy =
      face.status === 'fulfilled' && access.status === 'fulfilled';

    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'api-gateway',
      services: {
        faceService: value(face),
        accessService: value(access),
        shiftService: value(shift),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
