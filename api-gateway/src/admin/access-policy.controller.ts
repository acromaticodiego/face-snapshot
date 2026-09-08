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

import { AccessServiceClient } from '../proxy/service-clients';
import { AdminAuthGuard } from './admin-auth.guard';

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
    @Body() body: { roleId?: string; validUntil?: string },
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
