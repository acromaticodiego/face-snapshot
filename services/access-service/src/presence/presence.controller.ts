import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { PresenceService } from './presence.service';

/**
 * Quién hay dentro ahora mismo.
 *
 * Servicio interno: lo consume el Gateway, que es quien exige el token
 * de administrador. Aquí no se repite esa comprobación porque este
 * puerto no está publicado fuera de la red de Docker.
 *
 * Nótese que esto responde una pregunta distinta de la que responde el
 * Shift Service. Aquí está el hecho físico —quién ha pasado y no ha
 * salido, con consistencia fuerte porque gobierna las puertas—; allí,
 * su interpretación laboral —quién está en turno, quién de descanso—.
 * Pueden discrepar unos segundos, y eso no es un fallo: es la
 * diferencia entre el estado que abre una puerta y una hoja de horas.
 */
@ApiTags('presence')
@Controller('presence')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get()
  @ApiOperation({ summary: 'Personas que constan dentro, por zona' })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'zoneId', required: false })
  async list(
    @Query('siteId') siteId?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    const items = await this.presence.listInside({ siteId, zoneId });

    return {
      items,
      // Aforo por zona, que es lo que pinta el panel. Se calcula aquí y
      // no en el navegador para que dos clientes no puedan discrepar
      // sobre cuánta gente hay en un edificio.
      occupancyByZone: items.reduce<Record<string, number>>((counts, row) => {
        counts[row.zoneId] = (counts[row.zoneId] ?? 0) + 1;
        return counts;
      }, {}),
      // Personas distintas: alguien dentro del laboratorio consta
      // también dentro de las oficinas, así que sumar por zonas daría
      // un aforo inflado.
      totalPeople: new Set(items.map((row) => row.personId)).size,
    };
  }
}
