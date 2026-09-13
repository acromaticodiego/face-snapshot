import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  AccessServiceClient,
  FaceServiceClient,
  LogbookServiceClient,
  ShiftServiceClient,
  VoiceServiceClient,
} from '../proxy/service-clients';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly faces: FaceServiceClient,
    private readonly access: AccessServiceClient,
    private readonly shifts: ShiftServiceClient,
    private readonly voice: VoiceServiceClient,
    private readonly logbook: LogbookServiceClient,
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
    const [face, access, shift, voice, logbook] = await Promise.allSettled([
      this.faces.health(),
      this.access.health(),
      this.shifts.health(),
      this.voice.health(),
      this.logbook.health(),
    ]);

    const unreachable = { status: 'unreachable' };
    const value = (result: PromiseSettledResult<unknown>) =>
      result.status === 'fulfilled' ? result.value : unreachable;

    // Tres servicios NO entran en el estado general, y es la misma
    // razón en los tres: ninguno puede dejar a nadie fuera de un
    // edificio.
    //
    // El Shift Service es una proyección: si se cae, las horas dejan
    // de actualizarse pero las puertas siguen abriéndose y los eventos
    // esperan en la outbox. El Voice Service y el Logbook Service
    // sirven para dictar y firmar partes de relevo, que es trabajo de
    // oficina, no de cerradura.
    //
    // Marcar el sistema entero como degradado por cualquiera de ellos
    // haría que una alerta de nóminas o de bitácora pareciera una
    // avería de seguridad, y acabaría enseñando a ignorarla.
    const healthy =
      face.status === 'fulfilled' && access.status === 'fulfilled';

    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'api-gateway',
      services: {
        faceService: value(face),
        accessService: value(access),
        shiftService: value(shift),
        voiceService: value(voice),
        logbookService: value(logbook),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
