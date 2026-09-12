import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { StatsService } from './stats.service';

/**
 * Estadísticas de acceso.
 *
 * Servicio interno: lo consume el Gateway, que es quien exige el token
 * de administrador. Este puerto no está publicado fuera de la red de
 * Docker.
 */
@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('denials')
  @ApiOperation({ summary: 'Accesos denegados, agrupados por motivo' })
  @ApiQuery({ name: 'days', required: false, description: 'Por defecto 7' })
  @ApiQuery({ name: 'siteId', required: false })
  denials(@Query('days') days?: string, @Query('siteId') siteId?: string) {
    return this.stats.denials({ since: sinceFrom(days), siteId });
  }

  @Get('similarity')
  @ApiOperation({
    summary: 'Distribución de similitudes y qué implica para el umbral',
  })
  @ApiQuery({ name: 'days', required: false, description: 'Por defecto 30' })
  @ApiQuery({ name: 'siteId', required: false })
  similarity(@Query('days') days?: string, @Query('siteId') siteId?: string) {
    // Ventana más larga que el resto: un histograma necesita muestras
    // para significar algo, y una semana en una oficina pequeña deja
    // demasiados pocos puntos.
    return this.stats.similarity({ since: sinceFrom(days, 30), siteId });
  }

  @Get('hourly')
  @ApiOperation({ summary: 'Actividad por día de la semana y hora local' })
  @ApiQuery({ name: 'days', required: false, description: 'Por defecto 28' })
  @ApiQuery({ name: 'siteId', required: false })
  hourly(@Query('days') days?: string, @Query('siteId') siteId?: string) {
    // Cuatro semanas: suficiente para que un patrón semanal se vea y no
    // tanto como para que un cambio de turnos de hace meses lo emborrone.
    return this.stats.hourly({ since: sinceFrom(days, 28), siteId });
  }
}

/**
 * Convierte el parámetro `days` en una fecha de inicio.
 *
 * Se acota a 365 días: sin tope, un `days=100000` obligaría a recorrer
 * la tabla entera, y un panel no debería poder tumbar la base de datos
 * con un número escrito en la barra del navegador.
 */
function sinceFrom(days: string | undefined, fallback = 7): Date {
  const parsed = Number(days);
  const window =
    Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : fallback;

  return new Date(Date.now() - window * 24 * 3600 * 1000);
}
