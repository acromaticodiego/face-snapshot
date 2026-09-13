import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { HandoverSchema, type HandoverInput } from './handover.contract';
import { LogbookService } from './logbook.service';

/**
 * Bitácora de relevo de turno.
 *
 * Servicio INTERNO: lo llama el Gateway, que es quien comprueba los
 * tokens. Aquí no se repite esa verificación porque este puerto no está
 * publicado fuera de la red de Docker, igual que en el resto de
 * servicios.
 *
 * QUIEN FIRMA VIAJA EN CABECERA, NO EN EL CUERPO
 * ──────────────────────────────────────────────
 * El Gateway deduce la persona del token de sesión facial y la pasa en
 * `X-Person-Id` / `X-Person-Name`. No va en el cuerpo a propósito: un
 * cuerpo lo compone el cliente, y un parte firmado a nombre de otro
 * vaciaría de sentido el registro entero. Es la misma regla que ya
 * siguen `/home` y los descansos.
 */
@ApiTags('logbook')
@Controller('handovers')
export class LogbookController {
  constructor(private readonly logbook: LogbookService) {}

  @Post()
  @ApiOperation({ summary: 'Firmar un parte de relevo' })
  sign(
    @Headers('x-person-id') personId: string,
    @Headers('x-person-name') personName: string,
    @Body(new ZodValidationPipe(HandoverSchema)) body: HandoverInput,
  ) {
    if (!personId || !UUID.test(personId)) {
      // 400 y no 401: la autenticación es cosa del Gateway, y si esta
      // cabecera falta es que la petición está mal construida, no que
      // alguien no se haya identificado.
      throw new BadRequestException(
        'Falta la cabecera X-Person-Id, o no es un identificador válido',
      );
    }

    return this.logbook.sign(
      { personId, personName: (personName || 'Desconocido').slice(0, 120) },
      body,
    );
  }

  @Get('pending')
  @ApiOperation({
    summary: 'Incidencias sin cerrar, para quien entra al turno',
  })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'days', required: false, description: 'Por defecto 7' })
  pending(
    @Query('siteId') siteId?: string,
    @Query('days') days?: string,
    @Query('take') take?: string,
  ) {
    return this.logbook.pending({
      siteId,
      days: days ? Number(days) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get()
  @ApiOperation({ summary: 'Partes de relevo, del más reciente al más antiguo' })
  @ApiQuery({ name: 'personId', required: false })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Instante ISO 8601' })
  @ApiQuery({ name: 'to', required: false, description: 'Instante ISO 8601' })
  findMany(
    @Query('personId') personId?: string,
    @Query('siteId') siteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.logbook.findMany({
      personId,
      siteId,
      from: fecha(from, 'from'),
      to: fecha(to, 'to'),
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Un parte concreto, con sus incidencias' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.logbook.findOne(id);
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida una fecha antes de construirla.
 *
 * `new Date` con una cadena rara devuelve `Invalid Date` y Prisma
 * acabaría dando un error opaco sobre un parámetro. Es la misma
 * cautela que el Shift Service tiene con el parámetro `date`.
 */
function fecha(valor: string | undefined, campo: string): Date | undefined {
  if (!valor) return undefined;
  const parsed = new Date(valor);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`\`${campo}\` no es un instante válido`);
  }
  return parsed;
}
