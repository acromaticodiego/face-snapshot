import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ShiftsQuery } from './shifts.query';
import type { ShiftState } from './shift.machine';

/**
 * Consulta de la jornada.
 *
 * Servicio interno: lo llama el Gateway, que es quien comprueba los
 * tokens. Aquí no se repite esa verificación porque este puerto no
 * está publicado fuera de la red de Docker, igual que en el resto de
 * servicios.
 */
@ApiTags('shifts')
@Controller()
export class ShiftsController {
  constructor(private readonly shifts: ShiftsQuery) {}

  @Get('shifts/:personId/current')
  @ApiOperation({ summary: 'Estado de turno actual de una persona' })
  current(@Param('personId', ParseUUIDPipe) personId: string) {
    return this.shifts.current(personId);
  }

  @Get('shifts/:personId/timeline')
  @ApiOperation({ summary: 'Línea de tiempo de la jornada' })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'Día en formato AAAA-MM-DD, en hora local de la sede',
  })
  timeline(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Query('date') date?: string,
  ) {
    // Se valida el formato antes de construir la fecha: `new Date` con
    // una cadena rara devuelve Invalid Date y Prisma acabaría dando un
    // error opaco sobre un parámetro.
    const valid = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
    return this.shifts.timeline(personId, valid);
  }

  @Get('shifts')
  @ApiOperation({ summary: 'Jornadas abiertas, con el desglose por estado' })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: ['EN_TURNO', 'EN_DESCANSO', 'EN_PAUSA'],
  })
  openShifts(
    @Query('siteId') siteId?: string,
    @Query('state') state?: ShiftState,
  ) {
    return this.shifts.openShifts({ siteId, state });
  }
}
