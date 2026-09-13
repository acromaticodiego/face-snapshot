import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { LogbookServiceClient } from '../proxy/service-clients';
import { AdminAuthGuard } from './admin-auth.guard';

/**
 * Bitácora de relevo de turno, vista de administración.
 *
 * POR QUE EXIGE CUENTA DE ADMINISTRACION
 * ──────────────────────────────────────
 * Un parte cuenta lo que pasó en un turno, y de paso quién estaba, qué
 * no cuadró y quién lo dejó pendiente. Es información sobre terceros,
 * igual que el panel de operación, así que no basta con estar
 * reconocido: hace falta una cuenta.
 *
 * Lo que sí puede ver cualquiera identificado por su cara está en
 * `/me/logbook`: sus propios partes, y las incidencias pendientes que
 * necesita conocer para empezar su turno.
 *
 * SOLO LECTURA, Y NO POR OLVIDO
 * ─────────────────────────────
 * No hay aquí ningún método de escritura. Un parte lo firma quien
 * vivió el turno con su cara delante de una cámara; un administrador
 * que pudiera redactarlo por él convertiría la bitácora en algo que
 * no prueba nada.
 */
@ApiTags('admin/logbook')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin/logbook')
export class AdminHandoversController {
  constructor(private readonly logbook: LogbookServiceClient) {}

  @Get()
  @ApiOperation({ summary: 'Partes de relevo, del más reciente al más antiguo' })
  @ApiQuery({ name: 'personId', required: false })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Instante ISO 8601' })
  @ApiQuery({ name: 'to', required: false, description: 'Instante ISO 8601' })
  list(
    @Query('personId') personId?: string,
    @Query('siteId') siteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.logbook.findMany({ personId, siteId, from, to, skip, take });
  }

  @Get('pending')
  @ApiOperation({ summary: 'Incidencias sin cerrar en todas las sedes' })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'days', required: false, description: 'Por defecto 7' })
  pending(@Query('siteId') siteId?: string, @Query('days') days?: string) {
    return this.logbook.pending({ siteId, days });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Un parte concreto, con sus incidencias y el cruce de accesos',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.logbook.findOne(id);
  }
}
