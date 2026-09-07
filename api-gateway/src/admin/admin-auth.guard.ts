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
 * Protege todas las rutas /admin salvo el propio inicio de sesión.
 * Verifica la firma del token, su caducidad y —crucialmente— su TIPO.
 *
 * ACTIVADO POR DEFECTO. La variable ADMIN_AUTH_ENABLED permite
 * desactivarlo para depuración en local, y en ese caso el servicio lo
 * grita en los logs al arrancar. No debe desactivarse en ningún entorno
 * que alguien más pueda alcanzar.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  private readonly logger = new Logger(AdminAuthGuard.name);
  private readonly enabled: boolean;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('ADMIN_AUTH_ENABLED', 'true') !== 'false';

    if (!this.enabled) {
      this.logger.error(
        '*** ADMIN_AUTH_ENABLED=false: las rutas /admin estan ABIERTAS. ' +
          'Cualquiera puede registrar o eliminar personas. ' +
          'Usar solo en depuracion local. ***',
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
