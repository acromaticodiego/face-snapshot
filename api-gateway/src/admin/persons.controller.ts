import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import {
  UploadedImage,
  validateUploadedImage,
} from '../common/uploaded-image';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { FaceServiceClient } from '../proxy/service-clients';

const CreatePersonSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  externalId: z.string().trim().min(1).max(64).optional(),
});

const UpdatePersonSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});

/**
 * Administración de personas.
 *
 * PENDIENTE DE SEGURIDAD: estas rutas deben quedar detrás del guard de
 * administrador antes de exponer el sistema fuera de la red local. La
 * estructura ya está preparada (ver admin-auth.guard.ts); falta activar
 * el login. Documentado en el README.
 */
@ApiTags('admin/persons')
@Controller('admin/persons')
export class AdminPersonsController {
  private readonly maxImageBytes: number;

  constructor(
    private readonly faces: FaceServiceClient,
    config: ConfigService,
  ) {
    this.maxImageBytes = Number(config.get('MAX_IMAGE_SIZE_MB', 8)) * 1024 * 1024;
  }

  @Get()
  @ApiOperation({ summary: 'Lista las personas registradas' })
  list(
    @Query('search') search?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.faces.listPersons({ search, skip, take });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consulta una persona' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.faces.getPerson(id);
  }

  @Post()
  @ApiOperation({ summary: 'Crea una persona' })
  @UsePipes(new ZodValidationPipe(CreatePersonSchema))
  create(@Body() body: z.infer<typeof CreatePersonSchema>) {
    return this.faces.createPerson(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualiza nombre o estado' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdatePersonSchema))
    body: z.infer<typeof UpdatePersonSchema>,
  ) {
    return this.faces.updatePerson(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Elimina la persona y sus vectores faciales' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.faces.deletePerson(id);
  }

  @Post(':id/faces')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Captura y registra el rostro de una persona' })
  @UseInterceptors(FileInterceptor('file'))
  enroll(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImage,
  ) {
    const image = validateUploadedImage(file, this.maxImageBytes);
    return this.faces.enrollFace(
      id,
      image.buffer,
      image.originalname,
      image.mimetype,
    );
  }
}
