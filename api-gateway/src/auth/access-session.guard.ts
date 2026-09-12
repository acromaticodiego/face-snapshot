import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Guard de sesión de acceso.
 *
 * Es el reverso del guard de administrador: aquí solo valen los tokens
 * que emite el Access Service cuando alguien supera la votación
 * facial, y un token de administración NO sirve.
 *
 * POR QUE LA EXCLUSION VA EN LOS DOS SENTIDOS
 * ───────────────────────────────────────────
 * Que un token de acceso no sirva para administrar es evidente: quien
 * tuviera la cara registrada podría borrar a los demás (ADR 0006).
 *
 * Lo que no es tan evidente es por qué se rechaza también el camino
 * contrario. La razón es que estas rutas responden *sobre el sujeto
 * del token*: `/me/shift` devuelve la jornada de quien lo presenta,
 * leyendo su identidad de `sub`. Un token de administración tiene en
 * `sub` el identificador de una cuenta de `auth_svc`, que no es una
 * persona reconocible por la cámara: aceptarlo devolvería la jornada
 * de "nadie" o, peor, la de la persona que casualmente compartiera
 * identificador. Para ver la jornada de otro está `/admin/shifts`, que
 * pide el identificador de forma explícita.
 */

/** Identidad que el guard deja disponible para el controlador. */
export interface AccessSession {
  personId: string;
  personName: string;
  sessionId: string;
}

/** Petición con la sesión ya verificada. */
export type RequestWithSession = Request & { session?: AccessSession };

@Injectable()
export class AccessSessionGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Falta el token de sesión');
    }

    let payload: { sub?: string; name?: string; sid?: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Token inválido o caducado');
    }

    // Fuera del try: una excepción lanzada aquí dentro se confundiría
    // con un fallo de verificación y el mensaje diría "caducado"
    // cuando el problema es otro.
    if (payload.typ !== 'access-session' || !payload.sub) {
      throw new UnauthorizedException('El token no es de una sesión de acceso');
    }

    request.session = {
      personId: payload.sub,
      personName: payload.name ?? '',
      sessionId: payload.sid ?? '',
    };
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}
