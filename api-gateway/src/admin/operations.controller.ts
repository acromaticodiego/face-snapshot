import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import {
  AccessServiceClient,
  ShiftServiceClient,
} from '../proxy/service-clients';
import { AdminAuthGuard } from './admin-auth.guard';

/**
 * Panel de operación: quién hay dentro y cómo va su jornada.
 *
 * DOS FUENTES A PROPOSITO, Y NO UNA
 * ─────────────────────────────────
 * `/admin/presence` viene del Access Service y `/admin/shifts` del
 * Shift Service. Podría parecer que sobra una, pero responden
 * preguntas distintas:
 *
 *   · La presencia es el hecho físico —quién pasó y no ha salido—, se
 *     escribe en la misma transacción que la concesión y por eso puede
 *     gobernar una puerta.
 *   · La jornada es su interpretación laboral —en turno, de descanso,
 *     cuántas horas—, y se proyecta desde los eventos con unos
 *     segundos de retraso.
 *
 * Que difieran momentáneamente no es un fallo, es el diseño: una hoja
 * de horas puede ir un segundo por detrás; una cerradura, no.
 */
@ApiTags('admin/operations')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminOperationsController {
  constructor(
    private readonly access: AccessServiceClient,
    private readonly shifts: ShiftServiceClient,
  ) {}

  @Get('presence')
  @ApiOperation({ summary: 'Quién consta dentro ahora mismo, y el aforo' })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'zoneId', required: false })
  presence(@Query('siteId') siteId?: string, @Query('zoneId') zoneId?: string) {
    return this.access.listPresence({ siteId, zoneId });
  }

  @Get('shifts')
  @ApiOperation({ summary: 'Jornadas abiertas, con el desglose por estado' })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: ['EN_TURNO', 'EN_DESCANSO', 'EN_PAUSA'],
  })
  openShifts(@Query('siteId') siteId?: string, @Query('state') state?: string) {
    return this.shifts.openShifts({ siteId, state });
  }

  @Get('stats/denials')
  @ApiOperation({ summary: 'Accesos denegados, agrupados por motivo' })
  @ApiQuery({ name: 'days', required: false })
  @ApiQuery({ name: 'siteId', required: false })
  denials(@Query('days') days?: string, @Query('siteId') siteId?: string) {
    return this.access.stats('denials', { days, siteId });
  }

  @Get('stats/similarity')
  @ApiOperation({
    summary: 'Distribución de similitudes y margen del umbral en uso',
    description:
      'Las dos nubes están separadas por el propio umbral, así que de ' +
      'aquí NO salen tasas de error: sale el margen que queda a cada ' +
      'lado, que es lo que avisa de si el umbral va justo.',
  })
  @ApiQuery({ name: 'days', required: false })
  @ApiQuery({ name: 'siteId', required: false })
  similarity(@Query('days') days?: string, @Query('siteId') siteId?: string) {
    return this.access.stats('similarity', { days, siteId });
  }

  @Get('stats/hourly')
  @ApiOperation({ summary: 'Actividad por día de la semana y hora local' })
  @ApiQuery({ name: 'days', required: false })
  @ApiQuery({ name: 'siteId', required: false })
  hourly(@Query('days') days?: string, @Query('siteId') siteId?: string) {
    return this.access.stats('hourly', { days, siteId });
  }

  @Get('shifts/:personId/timeline')
  @ApiOperation({ summary: 'Línea de tiempo de la jornada de una persona' })
  @ApiQuery({ name: 'date', required: false, description: 'AAAA-MM-DD' })
  timeline(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Query('date') date?: string,
  ) {
    return this.shifts.timeline(personId, date);
  }
}
