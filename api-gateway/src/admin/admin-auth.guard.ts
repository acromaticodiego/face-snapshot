import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Guard de administrador.
 *
 * ESTADO ACTUAL (MVP): desactivado por defecto. Las rutas de /admin son
 * accesibles sin autenticación mientras el sistema corre en red local.
 *
 * Se activa poniendo ADMIN_AUTH_ENABLED=true. La estructura está
 * completa —verificación del token, tipo de token y claims— para que
 * activar el login sea añadir el endpoint de inicio de sesión, no
 * reescribir la capa de autorización.
 *
 * ANTES DE EXPONER EL SISTEMA A INTERNET ESTO DEBE ESTAR ACTIVADO.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  private readonly logger = new Logger(AdminAuthGuard.name);
  private readonly enabled: boolean;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('ADMIN_AUTH_ENABLED', 'false') === 'true';

    if (!this.enabled) {
      this.logger.warn(
        'Autenticación de administrador DESACTIVADA. ' +
          'Las rutas /admin están abiertas. No exponer este servicio a Internet.',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Falta el token de administrador');
    }

    try {
      const payload = await this.jwt.verifyAsync<{ typ?: string }>(token);

      // Un token de sesión de acceso (el que recibe una persona al ser
      // reconocida) NO debe servir para administrar. Se comprueba el tipo.
      if (payload.typ !== 'admin') {
        throw new UnauthorizedException('El token no es de administrador');
      }

      (request as Request & { admin?: unknown }).admin = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o caducado');
    }
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}
