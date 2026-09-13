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
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';

import {
  UploadedImage,
  validateUploadedImage,
} from '../common/uploaded-image';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  AccessServiceClient,
  FaceServiceClient,
} from '../proxy/service-clients';
import { AdminAuthGuard } from './admin-auth.guard';

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
 * Todas las rutas exigen un token de administrador válido, emitido por
 * el Auth Service tras un inicio de sesión correcto. El guard rechaza
 * ademas los tokens de sesión de acceso facial: son de otro tipo y no
 * sirven para administrar.
 */
@ApiTags('admin/persons')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin/persons')
export class AdminPersonsController {
  private readonly maxImageBytes: number;

  constructor(
    private readonly faces: FaceServiceClient,
    private readonly access: AccessServiceClient,
    config: ConfigService,
  ) {
    this.maxImageBytes = Number(config.get('MAX_IMAGE_SIZE_MB', 8)) * 1024 * 1024;
  }

  /**
   * Lista las personas con el rol que tienen asignado.
   *
   * Es el único sitio del Gateway donde se COMPONEN dos servicios, y
   * merece la pena decir por qué no contradice la regla de «cero
   * lógica de negocio»: aquí no se decide nada. La identidad vive en
   * el Face Service y el rol en el Access Service porque son dominios
   * distintos, pero quien administra necesita verlos juntos para
   * detectar a quien está registrado y no puede pasar por ninguna
   * puerta. Unir dos lecturas para una pantalla es precisamente el
   * trabajo de un Gateway; decidir con ellas, no.
   *
   * La alternativa —que el navegador pregunte los roles de cada
   * persona— serían N+1 peticiones por cada letra tecleada en el
   * buscador.
   */
  @Get()
  @ApiOperation({ summary: 'Lista las personas registradas con su rol' })
  async list(
    @Query('search') search?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    const page = (await this.faces.listPersons({ search, skip, take })) as {
      items: { id: string }[];
      total: number;
    };

    const byPerson = await this.access.lookupPersonRoles(
      page.items.map((person) => person.id),
    );

    return {
      ...page,
      items: page.items.map((person) => ({
        ...person,
        // `null` significa «no se pudo consultar», y es distinto de la
        // lista vacía, que significa «no tiene ningún rol». La interfaz
        // los pinta distinto: uno es una avería y el otro, un aviso.
        roles: byPerson ? (byPerson[person.id] ?? []) : null,
      })),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consulta una persona con su rol' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const person = (await this.faces.getPerson(id)) as Record<string, unknown>;
    const byPerson = await this.access.lookupPersonRoles([id]);
    return { ...person, roles: byPerson ? (byPerson[id] ?? []) : null };
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
