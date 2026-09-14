import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import {
  validateUploadedAudio,
  type UploadedAudio,
} from '../common/uploaded-audio';
import {
  LogbookServiceClient,
  ShiftServiceClient,
  VoiceServiceClient,
} from '../proxy/service-clients';
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
  private readonly maxAudioBytes: number;

  constructor(
    private readonly shifts: ShiftServiceClient,
    private readonly voice: VoiceServiceClient,
    private readonly logbook: LogbookServiceClient,
    config: ConfigService,
  ) {
    this.maxAudioBytes =
      Number(config.get<string>('MAX_AUDIO_SIZE_MB', '25')) * 1024 * 1024;
  }

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

  @Post('shift/break')
  @ApiOperation({
    summary: 'Declara que empiezas un descanso',
    description:
      'Para las pausas que no cruzan ningún lector: el baño, un café, ' +
      'comer en el propio puesto. No abre ni cierra la jornada.',
  })
  startBreak(
    @Req() request: RequestWithSession,
    @Body() body: { note?: string },
  ) {
    return this.shifts.changeShift(request.session!.personId, 'break', {
      note: body?.note,
    });
  }

  @Post('shift/resume')
  @ApiOperation({ summary: 'Declara que vuelves al trabajo' })
  endBreak(@Req() request: RequestWithSession) {
    return this.shifts.changeShift(request.session!.personId, 'resume');
  }

  // ── Bitácora de relevo de turno ────────────────────────────────

  @Post('logbook/draft')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Convierte un parte dictado en un borrador estructurado',
    description:
      'NO guarda nada. Devuelve una propuesta que hay que revisar y ' +
      'firmar con POST /me/logbook. Si el estructurador no responde, ' +
      'llega solo la transcripción y el parte se puede firmar igual.',
  })
  @UseInterceptors(FileInterceptor('file'))
  draft(@UploadedFile() file: UploadedAudio) {
    const audio = validateUploadedAudio(file, this.maxAudioBytes);
    return this.voice.logbookDraft(
      audio.buffer,
      audio.originalname || 'parte.webm',
      audio.mimetype,
    );
  }

  @Post('logbook')
  @ApiOperation({
    summary: 'Firma un parte de relevo',
    description:
      'Lo que se firma aquí es INMUTABLE: no hay edición ni borrado. ' +
      'Una corrección es un parte nuevo que apunta al anterior.',
  })
  signHandover(@Req() request: RequestWithSession, @Body() body: unknown) {
    // La persona sale del token, nunca del cuerpo. Es la misma regla
    // que el resto de este controlador, y aquí es todavía más
    // importante: un parte vale porque lo firmó quien vivió el turno.
    return this.logbook.sign(
      {
        personId: request.session!.personId,
        personName: request.session!.personName,
      },
      body,
    );
  }

  @Get('logbook')
  @ApiOperation({ summary: 'Partes de relevo propios' })
  @ApiQuery({ name: 'take', required: false })
  myHandovers(
    @Req() request: RequestWithSession,
    @Query('take') take?: string,
  ) {
    return this.logbook.findMany({
      personId: request.session!.personId,
      take,
    });
  }

  @Get('logbook/pending')
  @ApiOperation({
    summary: 'Incidencias sin cerrar que dejó el turno anterior',
    description:
      'Es lo que necesita ver quien entra a trabajar, y por eso no ' +
      'filtra por persona: lo que quedó pendiente lo dejó otro.',
  })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'days', required: false })
  pending(@Query('siteId') siteId?: string, @Query('days') days?: string) {
    return this.logbook.pending({ siteId, days });
  }

  @Post('logbook/incidents/:id/resolve')
  @ApiOperation({
    summary: 'Cierra una incidencia que dejó pendiente el turno anterior',
    description:
      'No edita nada: escribe una resolución que apunta a la ' +
      'incidencia, porque esta vive dentro de un parte firmado y un ' +
      'parte firmado no se toca. Quien cierra queda registrado.',
  })
  resolveIncident(
    @Req() request: RequestWithSession,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ) {
    // Quien cierra sale del token, igual que quien firma. Aquí importa
    // tanto como allí: una resolución dice que alguien comprobó que el
    // problema ya no está, y eso solo vale si se sabe quién lo dice.
    return this.logbook.resolveIncident(
      {
        personId: request.session!.personId,
        personName: request.session!.personName,
      },
      id,
      typeof body?.note === 'string' ? body.note : undefined,
    );
  }
}
