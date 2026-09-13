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
 * El tope coincide con el que aplica el Face Service al listar
 * personas: quien pregunta lo hace por una página de esa lista, así
 * que pedir más de lo que cabe en una página sería preguntar por
 * personas que nadie está mirando.
 */
const RolesLookupSchema = z.object({
  personIds: z.array(z.string().uuid()).min(1).max(200),
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

  /**
   * Roles de varias personas de una vez.
   *
   * Existe para que el Gateway pueda componer la lista de personas con
   * su rol sin hacer una petición por fila. Sin esto, pintar el panel
   * de administración con veinte personas serían veintiuna llamadas
   * entre servicios cada vez que alguien escribe una letra en el
   * buscador.
   *
   * Es una lectura, pero va por POST porque doscientos UUID no caben
   * con holgura en una cadena de consulta: son unos siete kilobytes de
   * URL, por encima de lo que algunos proxies aceptan sin avisar.
   */
  @Post('persons/roles/lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Roles asignados a un conjunto de personas' })
  async lookupPersonRoles(
    @Body(new ZodValidationPipe(RolesLookupSchema))
    body: z.infer<typeof RolesLookupSchema>,
  ) {
    const assignments = await this.prisma.personRole.findMany({
      where: { personId: { in: body.personIds } },
      include: { role: { select: { name: true } } },
    });

    // Se devuelve un mapa con TODAS las personas preguntadas, incluidas
    // las que no tienen ningún rol. Una clave ausente y una lista vacía
    // se leerían igual en el cliente, y no son lo mismo: sin rol es
    // justo el caso que esta pantalla existe para hacer visible.
    const byPerson: Record<string, { roleId: string; roleName: string }[]> =
      Object.fromEntries(body.personIds.map((id) => [id, []]));

    for (const assignment of assignments) {
      byPerson[assignment.personId].push({
        roleId: assignment.roleId,
        roleName: assignment.role.name,
      });
    }

    return { byPerson };
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
