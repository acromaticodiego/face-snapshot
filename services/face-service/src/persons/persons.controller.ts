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
import {
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';

import {
  UploadedImage,
  validateUploadedImage,
} from '../common/uploaded-image';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { FacesService } from '../faces/faces.service';
import { PersonsService } from './persons.service';

const CreatePersonSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  externalId: z.string().trim().min(1).max(64).optional(),
});

const UpdatePersonSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});

@ApiTags('persons')
@Controller('persons')
export class PersonsController {
  private readonly maxImageBytes: number;

  constructor(
    private readonly persons: PersonsService,
    private readonly faces: FacesService,
    config: ConfigService,
  ) {
    this.maxImageBytes = Number(config.get('MAX_IMAGE_SIZE_MB', 8)) * 1024 * 1024;
  }

  @Post()
  @ApiOperation({ summary: 'Registra una persona (todavía sin rostro)' })
  @UsePipes(new ZodValidationPipe(CreatePersonSchema))
  create(@Body() body: z.infer<typeof CreatePersonSchema>) {
    return this.persons.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'Lista las personas registradas' })
  findAll(
    @Query('search') search?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.persons.findAll({
      search,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consulta una persona' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.persons.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualiza nombre o estado' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdatePersonSchema))
    body: z.infer<typeof UpdatePersonSchema>,
  ) {
    return this.persons.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Elimina una persona y BORRA sus vectores faciales',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.persons.remove(id);
  }

  @Post(':id/faces')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Enrola un rostro y lo asocia a la persona' })
  @ApiResponse({
    status: 422,
    description: 'No se detectó rostro, hay varios, o la calidad es baja',
  })
  @UseInterceptors(FileInterceptor('file'))
  async enrollFace(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImage,
  ) {
    const image = validateUploadedImage(file, this.maxImageBytes);
    const result = await this.faces.enroll(
      id,
      image.buffer,
      image.originalname,
      image.mimetype,
    );
    return {
      ...result,
      message: 'Rostro registrado correctamente',
    };
  }
}
