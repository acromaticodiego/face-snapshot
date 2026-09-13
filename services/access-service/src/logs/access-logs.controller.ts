import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AccessLogsService } from './access-logs.service';
import { WindowSummaryService } from './window-summary.service';

/** Tope del intervalo que se puede pedir de una vez. */
const MAX_VENTANA_MS = 36 * 3600 * 1000;

@ApiTags('access-logs')
@Controller('access-logs')
export class AccessLogsController {
  constructor(
    private readonly logs: AccessLogsService,
    private readonly windows: WindowSummaryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Historial de intentos de acceso' })
  findAll(
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('granted') granted?: string,
  ) {
    return this.logs.findLogs({
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
      onlyGranted:
        granted === undefined ? undefined : granted === 'true',
    });
  }

  /**
   * Resumen de una franja horaria, para congelarlo en un parte de
   * relevo.
   *
   * Lo llama el Logbook Service al firmar. Va aqui y no en `/stats`
   * porque no es una estadistica de panel: es una lectura puntual de
   * lo que registraron las puertas entre dos instantes concretos.
   */
  @Get('window')
  @ApiOperation({
    summary: 'Resumen de accesos de una franja, para un parte de relevo',
  })
  @ApiQuery({ name: 'from', description: 'Instante ISO 8601' })
  @ApiQuery({ name: 'to', description: 'Instante ISO 8601' })
  @ApiQuery({ name: 'siteId', required: false })
  window(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') siteId?: string,
  ) {
    const desde = new Date(from);
    const hasta = new Date(to);

    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      throw new BadRequestException('`from` y `to` deben ser instantes ISO 8601');
    }
    if (hasta <= desde) {
      throw new BadRequestException('`to` debe ser posterior a `from`');
    }
    // Mismo criterio que el tope de `days` en las estadisticas: sin
    // limite, una peticion con un intervalo de diez anos recorreria la
    // tabla entera, y esto lo llama un servicio interno que podria
    // pedirlo por error.
    if (hasta.getTime() - desde.getTime() > MAX_VENTANA_MS) {
      throw new BadRequestException('El intervalo no puede superar las 36 horas');
    }

    return this.windows.summarize({ from: desde, to: hasta, siteId });
  }
}
