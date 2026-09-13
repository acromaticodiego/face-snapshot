import {
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ShiftsQuery } from './shifts.query';
import { ShiftsService } from './shifts.service';
import type { ManualRejection, ShiftState } from './shift.machine';

/**
 * Motivos que se pueden declarar al empezar un descanso.
 *
 * Lista cerrada y validada aquí, no texto libre. Es un dato que acaba
 * en la hoja de horas de una persona: dejarlo abierto invitaría a
 * escribir cualquier cosa y haría imposible agrupar nada después.
 */
const BreakSchema = z.object({
  note: z.enum(['DESCANSO', 'ALMUERZO', 'BANO', 'OTRO']).optional(),
});

/** Cada rechazo con su explicación, en lenguaje de quien lo lee. */
const REJECTIONS: Record<ManualRejection, string> = {
  NO_OPEN_DAY: 'No tienes una jornada abierta',
  ALREADY_ON_BREAK: 'Ya estabas en descanso',
  NOT_ON_BREAK: 'No estabas en descanso',
  OUTSIDE_SITE: 'Estás fuera de la sede: tu vuelta la registra la puerta',
};

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
  constructor(
    private readonly shifts: ShiftsQuery,
    private readonly changes: ShiftsService,
  ) {}

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

  @Post('shifts/:personId/break')
  @ApiOperation({ summary: 'La persona declara que empieza un descanso' })
  async startBreak(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Body(new ZodValidationPipe(BreakSchema))
    body: z.infer<typeof BreakSchema>,
  ) {
    return this.apply(personId, 'START_BREAK', body.note);
  }

  @Post('shifts/:personId/resume')
  @ApiOperation({ summary: 'La persona declara que vuelve al trabajo' })
  async endBreak(@Param('personId', ParseUUIDPipe) personId: string) {
    return this.apply(personId, 'END_BREAK');
  }

  /**
   * Un cambio rechazado devuelve 409 y no 400.
   *
   * La petición está bien formada: lo que no encaja es el estado en el
   * que está la jornada ahora mismo, y eso es un conflicto, no un
   * error del cliente. La diferencia importa porque el cliente no
   * puede corregir un 400 reintentando y aquí sí: basta con que la
   * persona entre por la puerta primero.
   */
  private async apply(
    personId: string,
    change: 'START_BREAK' | 'END_BREAK',
    note?: string,
  ) {
    const result = await this.changes.requestManualChange({
      personId,
      change,
      note,
    });

    if (!result.ok) {
      throw new ConflictException({
        message: REJECTIONS[result.reason],
        code: result.reason,
      });
    }

    return this.shifts.current(personId);
  }
}
