import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ShiftServiceClient } from '../proxy/service-clients';
import {
  AccessSessionGuard,
  type RequestWithSession,
} from './access-session.guard';

/**
 * Lo que puede consultar una persona sobre sí misma.
 *
 * El identificador NO viaja en la ruta ni en la consulta: se lee del
 * token que emitió el Access Service tras reconocer la cara. Si
 * `/me/shift` aceptase un `personId`, cualquiera con una sesión válida
 * podría leer la jornada de sus compañeros cambiando un parámetro en
 * la barra del navegador. Es el fallo de autorización más común que
 * hay, y la única forma de no cometerlo es no aceptar el dato.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(AccessSessionGuard)
@Controller('me')
export class MeController {
  constructor(private readonly shifts: ShiftServiceClient) {}

  @Get('shift')
  @ApiOperation({
    summary: 'Estado de turno y horas acumuladas de quien presenta el token',
  })
  shift(@Req() request: RequestWithSession) {
    return this.shifts.currentShift(request.session!.personId);
  }

  @Get('timeline')
  @ApiOperation({ summary: 'Línea de tiempo de la jornada propia' })
  @ApiQuery({ name: 'date', required: false, description: 'AAAA-MM-DD' })
  timeline(@Req() request: RequestWithSession, @Query('date') date?: string) {
    return this.shifts.timeline(request.session!.personId, date);
  }
}
