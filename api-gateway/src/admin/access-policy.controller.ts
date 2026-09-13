import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AccessServiceClient } from '../proxy/service-clients';
import { AdminAuthGuard } from './admin-auth.guard';

/**
 * El Access Service vuelve a validar esto por su cuenta, y debe
 * seguir haciéndolo: es la autoridad sobre quién puede pasar y no
 * puede fiarse de quien le llama. Aquí se valida igualmente porque el
 * Gateway es la frontera con el exterior, y un `roleId` que no es un
 * UUID tiene que morir en el borde y no viajar hacia dentro para
 * volver como el error de un servicio interno.
 */
const AssignRoleSchema = z.object({
  roleId: z.string().uuid(),
  /** ISO 8601. Sin valor, la asignación no caduca. */
  validUntil: z.string().datetime().optional(),
});

/**
 * Administración del dominio de acceso: sedes, roles y asignaciones.
 *
 * Decidir quién puede entrar a dónde es la operación más sensible del
 * sistema, así que exige token de administrador como el resto de /admin.
 */
@ApiTags('admin/access-policy')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminAccessPolicyController {
  constructor(private readonly access: AccessServiceClient) {}

  @Get('sites')
  @ApiOperation({ summary: 'Sedes con sus zonas y puntos de acceso' })
  listSites() {
    return this.access.listSites();
  }

  @Get('roles')
  @ApiOperation({ summary: 'Roles y qué permite cada uno' })
  listRoles() {
    return this.access.listRoles();
  }

  @Get('persons/:personId/roles')
  @ApiOperation({ summary: 'Roles asignados a una persona' })
  listPersonRoles(@Param('personId', ParseUUIDPipe) personId: string) {
    return this.access.listPersonRoles(personId);
  }

  @Post('persons/:personId/roles')
  @ApiOperation({ summary: 'Asigna un rol a una persona' })
  assignRole(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Body(new ZodValidationPipe(AssignRoleSchema))
    body: z.infer<typeof AssignRoleSchema>,
  ) {
    return this.access.assignRole(personId, body);
  }

  @Delete('persons/:personId/roles/:roleId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retira un rol a una persona' })
  revokeRole(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ) {
    return this.access.revokeRole(personId, roleId);
  }
}
