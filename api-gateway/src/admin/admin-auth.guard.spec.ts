import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AdminAuthGuard } from './admin-auth.guard';

/**
 * El perímetro de administración.
 *
 * POR QUE ESTE ARCHIVO EXISTE
 * ───────────────────────────
 * Una sola línea del guard —`payload.typ !== 'admin'`— es lo único que
 * impide que el token que recibe una persona al ser reconocida por la
 * cámara sirva para registrar y eliminar a sus compañeros. Es la
 * garantía central del ADR 0006, y hasta ahora no la comprobaba nada.
 *
 * Lo peligroso de esa línea es que falla ABIERTO. Si desaparece en un
 * refactor, un token con firma válida —cualquier token de sesión
 * facial, que emite el propio sistema— pasa el guard y nada se rompe
 * visiblemente: no hay error, no hay traza, no hay alerta. Solo deja de
 * haber control de acceso.
 *
 * SE FIRMA DE VERDAD, NO SE SIMULA
 * ────────────────────────────────
 * Los tokens de estas pruebas se firman con un `JwtService` real. Un
 * doble que devolviese un objeto cualquiera probaria que el guard sabe
 * leer un objeto, que no es lo que hay que demostrar: lo que hay que
 * demostrar es que rechaza una firma mala y una caducidad pasada, y eso
 * solo lo prueba la biblioteca de verdad.
 */

const SECRETO = 'un-secreto-de-pruebas-suficientemente-largo-1234567890';

const jwt = new JwtService({ secret: SECRETO });

/** Otro emisor, con otra clave: simula un token falsificado. */
const jwtIntruso = new JwtService({ secret: 'otra-clave-completamente-distinta-0987654321' });

/** Contexto de NestJS con la cabecera que se quiera. */
function contexto(authorization?: string) {
  const request: Record<string, unknown> = {
    headers: authorization ? { authorization } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    __request: request,
  } as unknown as ExecutionContext & { __request: Record<string, unknown> };
}

const config = (valores: Record<string, string> = {}) =>
  ({
    get: (clave: string, porDefecto: string) => valores[clave] ?? porDefecto,
  }) as unknown as ConfigService;

const guard = (valores?: Record<string, string>) =>
  new AdminAuthGuard(jwt, config(valores));

describe('AdminAuthGuard', () => {
  describe('la separación entre administrar y estar reconocido', () => {
    it('ACEPTA un token de administración', async () => {
      const token = await jwt.signAsync({ sub: 'admin-1', typ: 'admin' });
      const ctx = contexto(`Bearer ${token}`);

      await expect(guard().canActivate(ctx)).resolves.toBe(true);
    });

    it('RECHAZA un token de sesión facial, aunque su firma sea válida', async () => {
      // Este es el test que justifica el archivo entero. El token lo
      // emite el propio sistema y su firma es perfecta: lo único que lo
      // distingue de uno de administración es el campo `typ`.
      const token = await jwt.signAsync({
        sub: 'persona-1',
        name: 'Diego Ossa',
        typ: 'access-session',
      });

      await expect(
        guard().canActivate(contexto(`Bearer ${token}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('RECHAZA un token sin campo de tipo', async () => {
      // Un token antiguo, anterior a que existiera `typ`, no debe
      // colarse por omisión. La comprobación es `!== 'admin'`, no
      // `=== 'access-session'`, y esto lo fija.
      const token = await jwt.signAsync({ sub: 'quien-sea' });

      await expect(
        guard().canActivate(contexto(`Bearer ${token}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('deja la identidad del administrador disponible para el controlador', async () => {
      const token = await jwt.signAsync({
        sub: 'admin-1',
        email: 'admin@detector.local',
        typ: 'admin',
      });
      const ctx = contexto(`Bearer ${token}`);

      await guard().canActivate(ctx);

      expect(ctx.__request.admin).toMatchObject({
        sub: 'admin-1',
        email: 'admin@detector.local',
        typ: 'admin',
      });
    });
  });

  describe('la firma y la caducidad', () => {
    it('rechaza un token firmado con otra clave', async () => {
      const falsificado = await jwtIntruso.signAsync({ sub: 'x', typ: 'admin' });

      await expect(
        guard().canActivate(contexto(`Bearer ${falsificado}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza un token caducado', async () => {
      const caducado = await jwt.signAsync(
        { sub: 'admin-1', typ: 'admin' },
        { expiresIn: '-1s' },
      );

      await expect(
        guard().canActivate(contexto(`Bearer ${caducado}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza un token manipulado', async () => {
      const token = await jwt.signAsync({ sub: 'persona', typ: 'access-session' });
      // Se cambia el contenido dejando la firma original: es el ataque
      // ingenuo contra un JWT, y tiene que morir en la verificación.
      const [cabecera, , firma] = token.split('.');
      const cuerpoFalso = Buffer.from(
        JSON.stringify({ sub: 'persona', typ: 'admin' }),
      ).toString('base64url');

      await expect(
        guard().canActivate(contexto(`Bearer ${cabecera}.${cuerpoFalso}.${firma}`)),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('la cabecera', () => {
    it('rechaza una petición sin cabecera', async () => {
      await expect(guard().canActivate(contexto())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rechaza un esquema que no sea Bearer', async () => {
      const token = await jwt.signAsync({ sub: 'admin-1', typ: 'admin' });

      await expect(
        guard().canActivate(contexto(`Basic ${token}`)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('acepta el esquema en cualquier combinación de mayúsculas', async () => {
      // Los clientes HTTP no se ponen de acuerdo en esto y el RFC dice
      // que el esquema no distingue mayúsculas.
      const token = await jwt.signAsync({ sub: 'admin-1', typ: 'admin' });

      await expect(
        guard().canActivate(contexto(`bearer ${token}`)),
      ).resolves.toBe(true);
    });

    it('rechaza una cabecera Bearer vacía', async () => {
      await expect(guard().canActivate(contexto('Bearer'))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('el interruptor de depuración', () => {
    it('con ADMIN_AUTH_ENABLED=false deja pasar sin token', async () => {
      // Está documentado y es deliberado, pero conviene que exista una
      // prueba que lo diga en voz alta: con esa variable, /admin queda
      // ABIERTO. Si alguien la pone en un entorno alcanzable, no hay
      // control de acceso a la administración.
      const abierto = guard({ ADMIN_AUTH_ENABLED: 'false' });

      await expect(abierto.canActivate(contexto())).resolves.toBe(true);
    });

    it('solo la cadena exacta "false" lo desactiva', async () => {
      // Un valor tipeado a medias no puede abrir el sistema por
      // accidente.
      for (const valor of ['False', 'FALSE', '0', 'no', '']) {
        await expect(
          guard({ ADMIN_AUTH_ENABLED: valor }).canActivate(contexto()),
        ).rejects.toThrow(UnauthorizedException);
      }
    });

    it('activado por defecto cuando la variable no está definida', async () => {
      await expect(guard().canActivate(contexto())).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
