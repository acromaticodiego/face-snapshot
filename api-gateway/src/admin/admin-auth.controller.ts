import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { AuthServiceClient } from '../proxy/service-clients';
import { AdminAuthGuard } from './admin-auth.guard';

@ApiTags('admin/auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AuthServiceClient) {}

  /**
   * Inicio de sesión de administrador.
   *
   * Es la ÚNICA ruta bajo /admin que no exige token: sería imposible
   * obtener uno de otro modo. La validación de las credenciales ocurre
   * íntegramente en el Auth Service; aquí solo se reenvía.
   */
  @Post('login')
  @ApiOperation({ summary: 'Inicia sesión y obtiene el token de administración' })
  login(@Body() body: { email?: string; password?: string }) {
    return this.auth.login(body);
  }

  /**
   * Datos del administrador autenticado.
   *
   * El frontend lo usa al cargar para saber si el token guardado sigue
   * siendo válido, sin tener que decodificarlo por su cuenta.
   */
  @Get('me')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Devuelve el administrador de la sesión actual' })
  me(@Req() request: Request) {
    const admin = (request as Request & { admin?: Record<string, unknown> })
      .admin;
    return {
      id: admin?.sub,
      email: admin?.email,
      displayName: admin?.name,
      role: admin?.role,
    };
  }
}
