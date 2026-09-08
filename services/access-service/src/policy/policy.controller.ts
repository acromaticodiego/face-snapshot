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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';

const AssignRoleSchema = z.object({
  roleId: z.string().uuid(),
  /** ISO 8601. Sin valor, la asignación no caduca. */
  validUntil: z.string().datetime().optional(),
});

/**
 * Administración del dominio de acceso.
 *
 * Servicio interno: lo consume el Gateway, que es quien exige el token
 * de administrador. Aquí no se repite esa comprobación porque este
 * puerto no está publicado fuera de la red de Docker.
 */
@ApiTags('access-policy')
@Controller()
export class PolicyController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('sites')
  @ApiOperation({ summary: 'Sedes con sus zonas y puntos de acceso' })
  async listSites() {
    const sites = await this.prisma.site.findMany({
      include: {
        zones: {
          include: { accessPoints: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
    return { items: sites };
  }

  @Get('roles')
  @ApiOperation({ summary: 'Roles con sus permisos' })
  async listRoles() {
    const roles = await this.prisma.role.findMany({
      include: {
        permissions: {
          include: {
            zone: { select: { name: true } },
            schedule: { select: { name: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return {
      items: roles.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description,
        isActive: role.isActive,
        permissions: role.permissions.map((permission) => ({
          zone: permission.zone.name,
          schedule: permission.schedule.name,
        })),
      })),
    };
  }

  @Get('schedules')
  @ApiOperation({ summary: 'Horarios definidos' })
  async listSchedules() {
    const schedules = await this.prisma.schedule.findMany({
      include: { rules: { orderBy: [{ weekday: 'asc' }] } },
      orderBy: { name: 'asc' },
    });
    return { items: schedules };
  }

  @Get('persons/:personId/roles')
  @ApiOperation({ summary: 'Roles asignados a una persona' })
  async listPersonRoles(@Param('personId', ParseUUIDPipe) personId: string) {
    const assignments = await this.prisma.personRole.findMany({
      where: { personId },
      include: { role: { select: { name: true, description: true } } },
    });

    return {
      items: assignments.map((assignment) => ({
        id: assignment.id,
        roleId: assignment.roleId,
        roleName: assignment.role.name,
        validFrom: assignment.validFrom,
        validUntil: assignment.validUntil,
      })),
    };
  }

  @Post('persons/:personId/roles')
  @ApiOperation({ summary: 'Asigna un rol a una persona' })
  async assignRole(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Body(new ZodValidationPipe(AssignRoleSchema))
    body: z.infer<typeof AssignRoleSchema>,
  ) {
    const assignment = await this.prisma.personRole.upsert({
      where: { personId_roleId: { personId, roleId: body.roleId } },
      update: {
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
      },
      create: {
        personId,
        roleId: body.roleId,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
      },
      include: { role: { select: { name: true } } },
    });

    return {
      id: assignment.id,
      roleId: assignment.roleId,
      roleName: assignment.role.name,
      validUntil: assignment.validUntil,
    };
  }

  @Delete('persons/:personId/roles/:roleId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retira un rol a una persona' })
  async revokeRole(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ) {
    await this.prisma.personRole.deleteMany({ where: { personId, roleId } });
    return { revoked: true };
  }
}
