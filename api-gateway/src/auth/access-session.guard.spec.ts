import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AccessSessionGuard, type RequestWithSession } from './access-session.guard';

/**
 * El perímetro de `/me`, que es el reverso del de administración.
 *
 * LO QUE HAY QUE DEMOSTRAR AQUI
 * ─────────────────────────────
 * Que la exclusión funciona en LOS DOS SENTIDOS. Que un token de acceso
 * no sirva para administrar es evidente; que un token de administración
 * no sirva aquí lo es menos, y por eso es lo que más fácil resulta
 * romper sin darse cuenta.
 *
 * El motivo está en el guard: estas rutas responden *sobre el sujeto
 * del token*. `/me/shift` devuelve la jornada de quien lo presenta,
 * leyendo su identidad de `sub`. Un token de administración tiene ahí
 * el identificador de una cuenta de `auth_svc`, que no es una persona
 * reconocible por la cámara.
 *
 * Y DE QUE EL IDENTIFICADOR NO VIAJA EN LA PETICION
 * ────────────────────────────────────────────────
 * La identidad sale del token y solo del token. Si se aceptara como
 * parámetro, cualquiera con una sesión válida leería la jornada de sus
 * compañeros cambiando un número en la barra del navegador. Estas
 * pruebas fijan que el guard es quien la pone.
 */

const SECRETO = 'un-secreto-de-pruebas-suficientemente-largo-1234567890';
const jwt = new JwtService({ secret: SECRETO });
const jwtIntruso = new JwtService({ secret: 'otra-clave-distinta-abcdefghijklmnop' });

function contexto(authorization?: string) {
  const request: Partial<RequestWithSession> = {
    headers: (authorization ? { authorization } : {}) as RequestWithSession['headers'],
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    __request: request,
  } as unknown as ExecutionContext & { __request: Partial<RequestWithSession> };
}

const guard = new AccessSessionGuard(jwt);

describe('AccessSessionGuard', () => {
  describe('la exclusión mutua con el token de administración', () => {
    it('ACEPTA un token de sesión de acceso', async () => {
      const token = await jwt.signAsync({
        sub: 'persona-1',
        name: 'Diego Ossa',
        sid: 'sesion-1',
        typ: 'access-session',
      });

      await expect(
        guard.canActivate(contexto(`Bearer ${token}`)),
      ).resolves.toBe(true);
    });

    it('RECHAZA un token de administración, aunque su firma sea válida', async () => {
      // El sentido menos evidente de la exclusión, y el que más fácil
      // es romper: aceptarlo devolvería la jornada de "nadie" o, peor,
      // la de la persona que casualmente compartiera identificador con
      // una cuenta de administración.
      const token = await jwt.signAsync({ sub: 'admin-1', typ: 'admin' });

      await expect(
        guard.canActivate(contexto(`Bearer ${token}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('RECHAZA un token sin campo de tipo', async () => {
      const token = await jwt.signAsync({ sub: 'persona-1' });

      await expect(
        guard.canActivate(contexto(`Bearer ${token}`)),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('la identidad sale del token y de ningún otro sitio', () => {
    it('deja la sesión disponible para el controlador', async () => {
      const token = await jwt.signAsync({
        sub: 'persona-7',
        name: 'Kelly',
        sid: 'sesion-42',
        typ: 'access-session',
      });
      const ctx = contexto(`Bearer ${token}`);

      await guard.canActivate(ctx);

      expect(ctx.__request.session).toEqual({
        personId: 'persona-7',
        personName: 'Kelly',
        sessionId: 'sesion-42',
      });
    });

    it('rechaza un token sin sujeto', async () => {
      // Sin `sub` no hay de quién responder. Dejarlo pasar daría una
      // sesión con `personId` vacío, y la consulta de jornada
      // devolvería lo que encontrase con esa clave.
      const token = await jwt.signAsync({ typ: 'access-session', name: 'X' });

      await expect(
        guard.canActivate(contexto(`Bearer ${token}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('tolera que falten el nombre y el identificador de sesión', async () => {
      // Son datos de presentación: su ausencia no es un problema de
      // seguridad y no debe cerrar la puerta a quien sí está
      // identificado.
      const token = await jwt.signAsync({ sub: 'persona-9', typ: 'access-session' });
      const ctx = contexto(`Bearer ${token}`);

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(ctx.__request.session).toEqual({
        personId: 'persona-9',
        personName: '',
        sessionId: '',
      });
    });
  });

  describe('la firma, la caducidad y la cabecera', () => {
    it('rechaza un token firmado con otra clave', async () => {
      const falsificado = await jwtIntruso.signAsync({
        sub: 'persona-1',
        typ: 'access-session',
      });

      await expect(
        guard.canActivate(contexto(`Bearer ${falsificado}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza un token caducado', async () => {
      const caducado = await jwt.signAsync(
        { sub: 'persona-1', typ: 'access-session' },
        { expiresIn: '-1s' },
      );

      await expect(
        guard.canActivate(contexto(`Bearer ${caducado}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza una petición sin cabecera', async () => {
      await expect(guard.canActivate(contexto())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rechaza un esquema que no sea Bearer', async () => {
      const token = await jwt.signAsync({ sub: 'p', typ: 'access-session' });

      await expect(
        guard.canActivate(contexto(`Basic ${token}`)),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('los mensajes de error distinguen la causa', () => {
    // El guard separa a propósito el fallo de verificación del fallo de
    // tipo, y lo hace sacando la comprobación fuera del `try`. Sin eso,
    // un token de administración perfectamente válido diría "caducado",
    // y quien depure perseguiría un problema de relojes que no existe.
    it('un token válido pero de otro tipo no dice "caducado"', async () => {
      const token = await jwt.signAsync({ sub: 'admin-1', typ: 'admin' });

      await expect(
        guard.canActivate(contexto(`Bearer ${token}`)),
      ).rejects.toThrow('El token no es de una sesión de acceso');
    });

    it('un token con firma mala sí habla de validez', async () => {
      const falsificado = await jwtIntruso.signAsync({
        sub: 'p',
        typ: 'access-session',
      });

      await expect(
        guard.canActivate(contexto(`Bearer ${falsificado}`)),
      ).rejects.toThrow('Token inválido o caducado');
    });
  });
});
