import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

/**
 * El login de administración.
 *
 * QUE SE PRUEBA Y QUE NO
 * ──────────────────────
 * argon2 está doblado a propósito. Que argon2 hashee bien no es código
 * de este proyecto y probarlo aquí solo añadiría segundos por test. Lo
 * que sí es de este proyecto, y no lo comprobaba nada, es la LOGICA
 * que lo rodea: a quién se deja entrar, qué se le responde a quién, y
 * cuándo se bloquea una cuenta.
 *
 * LAS DOS GARANTIAS QUE ESTE ARCHIVO FIJA
 * ───────────────────────────────────────
 * 1. **No se puede enumerar quién es administrador.** Ni por el mensaje
 *    —que es idéntico en todos los casos— ni por el TIEMPO. Lo segundo
 *    es lo sutil: si el correo no existe, el servicio verifica de todas
 *    formas contra un hash de descarte, para tardar lo mismo. Un
 *    retorno temprano para correos desconocidos rompería esa garantía
 *    sin romper ningún test que mire solo el mensaje, y por eso aquí se
 *    comprueba que `verify` se llama igualmente.
 * 2. **El token emitido lleva `typ: 'admin'`**, que es lo que impide
 *    que un token de sesión facial sirva para administrar. Es la otra
 *    mitad de lo que comprueba el guard del Gateway: aquí se fija que
 *    el campo se emite, allí que se exige.
 */

const mockArgon2 = {
  hash: jest.fn(async () => '$argon2id$hash-de-prueba'),
  verify: jest.fn(async () => true),
};
// El nombre empieza por `mock` porque jest solo permite referenciar
// variables externas en la fabrica del mock si lo hacen: la llamada se
// eleva por encima de las declaraciones y cualquier otro nombre daria
// un error de variable fuera de alcance.
jest.mock('@node-rs/argon2', () => mockArgon2);

// Se importa DESPUES del mock: el servicio usa argon2 en el ámbito del
// módulo y un import anterior se llevaría el módulo real.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AdminAuthService } = require('./admin-auth.service') as typeof import('./admin-auth.service');

const ADMIN = {
  id: 'admin-1',
  email: 'admin@detector.local',
  displayName: 'Administrador',
  role: 'ADMIN',
  passwordHash: '$argon2id$hash-real',
  isActive: true,
  failedAttempts: 0,
  lockedUntil: null as Date | null,
};

/** Doble de Prisma con solo lo que el servicio usa. */
function fakePrisma(admin: typeof ADMIN | null) {
  const updates: { where: unknown; data: Record<string, unknown> }[] = [];
  return {
    adminUser: {
      findUnique: jest.fn(async () => admin),
      findFirst: jest.fn(async () => admin),
      update: jest.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return admin;
      }),
    },
    updates,
  };
}

const jwt = new JwtService({ secret: 'secreto-de-pruebas-largo-1234567890abcdef' });
const config = { get: (_k: string, d: string) => d } as unknown as ConfigService;

async function servicio(admin: typeof ADMIN | null) {
  const prisma = fakePrisma(admin);
  const s = new AdminAuthService(prisma as never, jwt, config);
  // Genera el hash de descarte, igual que haría Nest al arrancar.
  await s.onModuleInit();
  return { s, prisma };
}

beforeEach(() => {
  mockArgon2.hash.mockClear();
  mockArgon2.verify.mockClear();
  mockArgon2.verify.mockResolvedValue(true);
});

describe('AdminAuthService.login', () => {
  describe('no se puede averiguar quién es administrador', () => {
    it('responde lo mismo exista la cuenta o no', async () => {
      const { s: conCuenta } = await servicio(ADMIN);
      mockArgon2.verify.mockResolvedValue(false);
      const errorConCuenta = await conCuenta
        .login('admin@detector.local', 'mala')
        .catch((e: Error) => e.message);

      const { s: sinCuenta } = await servicio(null);
      const errorSinCuenta = await sinCuenta
        .login('noexiste@detector.local', 'mala')
        .catch((e: Error) => e.message);

      expect(errorConCuenta).toBe(errorSinCuenta);
      expect(errorConCuenta).toBe('Credenciales inválidas');
    });

    it('VERIFICA UN HASH aunque la cuenta no exista', async () => {
      // La garantía es de TIEMPO, no de mensaje, y es la que más fácil
      // se pierde: basta con que alguien añada un `if (!admin) throw`
      // antes de la verificación. El mensaje seguiría siendo idéntico y
      // ningún test que mire solo el texto lo notaría, pero los correos
      // inexistentes pasarían a contestar al instante y los válidos
      // tras calcular argon2. Eso es un oráculo de enumeración.
      const { s } = await servicio(null);

      await s.login('noexiste@detector.local', 'lo-que-sea').catch(() => undefined);

      expect(mockArgon2.verify).toHaveBeenCalledTimes(1);
    });

    it('el hash de descarte se calcula con los mismos parámetros que los reales', async () => {
      // Si fuera más barato de verificar, volvería a haber diferencia
      // de tiempo y la defensa no serviría de nada.
      await servicio(null);

      expect(mockArgon2.hash).toHaveBeenCalledWith(expect.any(String), {
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
    });

    it('una cuenta desactivada responde igual que una inexistente', async () => {
      const { s } = await servicio({ ...ADMIN, isActive: false });

      await expect(
        s.login('admin@detector.local', 'la-correcta'),
      ).rejects.toThrow('Credenciales inválidas');
    });

    it('normaliza el correo antes de buscarlo', async () => {
      // Sin esto, la misma cuenta tendría comportamientos distintos
      // según cómo se escribiera el correo, y el bloqueo por intentos
      // se esquivaría alternando mayúsculas.
      const { s, prisma } = await servicio(ADMIN);

      await s.login('  ADMIN@Detector.Local  ', 'x').catch(() => undefined);

      expect(prisma.adminUser.findUnique).toHaveBeenCalledWith({
        where: { email: 'admin@detector.local' },
      });
    });
  });

  describe('el bloqueo por intentos fallidos', () => {
    it('cuenta el intento fallido sin bloquear todavía', async () => {
      const { s, prisma } = await servicio({ ...ADMIN, failedAttempts: 1 });
      mockArgon2.verify.mockResolvedValue(false);

      await s.login('admin@detector.local', 'mala').catch(() => undefined);

      expect(prisma.updates[0].data).toMatchObject({
        failedAttempts: 2,
        lockedUntil: null,
      });
    });

    it('al quinto intento bloquea la cuenta', async () => {
      const { s, prisma } = await servicio({ ...ADMIN, failedAttempts: 4 });
      mockArgon2.verify.mockResolvedValue(false);

      await s.login('admin@detector.local', 'mala').catch(() => undefined);

      const data = prisma.updates[0].data as {
        failedAttempts: number;
        lockedUntil: Date;
      };
      expect(data.lockedUntil).toBeInstanceOf(Date);
      expect(data.lockedUntil.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      // El contador se reinicia porque a partir de aquí manda la fecha
      // de bloqueo, no el numero de intentos.
      expect(data.failedAttempts).toBe(0);
    });

    it('una cuenta bloqueada se rechaza AUNQUE la contraseña sea correcta', async () => {
      const { s } = await servicio({
        ...ADMIN,
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      });
      mockArgon2.verify.mockResolvedValue(true);

      await expect(
        s.login('admin@detector.local', 'la-correcta'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('un bloqueo ya vencido deja entrar de nuevo', async () => {
      const { s } = await servicio({
        ...ADMIN,
        lockedUntil: new Date(Date.now() - 1_000),
      });

      await expect(
        s.login('admin@detector.local', 'la-correcta'),
      ).resolves.toMatchObject({ admin: { email: 'admin@detector.local' } });
    });

    it('no intenta contar intentos de una cuenta que no existe', async () => {
      // Escribir en la base de datos por cada correo inventado sería un
      // camino directo a llenarla desde fuera.
      const { s, prisma } = await servicio(null);
      mockArgon2.verify.mockResolvedValue(false);

      await s.login('noexiste@detector.local', 'x').catch(() => undefined);

      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });
  });

  describe('el token que emite', () => {
    it('lleva typ: admin, que es lo que exige el guard del Gateway', async () => {
      const { s } = await servicio(ADMIN);

      const { accessToken } = await s.login('admin@detector.local', 'la-correcta');

      expect(jwt.decode(accessToken)).toMatchObject({
        sub: 'admin-1',
        email: 'admin@detector.local',
        typ: 'admin',
      });
    });

    it('no devuelve el hash de la contraseña', async () => {
      const { s } = await servicio(ADMIN);

      const { admin } = await s.login('admin@detector.local', 'la-correcta');

      expect(admin).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(admin)).not.toContain('argon2');
    });

    it('al entrar bien reinicia el contador y levanta el bloqueo', async () => {
      const { s, prisma } = await servicio({ ...ADMIN, failedAttempts: 3 });

      await s.login('admin@detector.local', 'la-correcta');

      expect(prisma.updates[0].data).toMatchObject({
        failedAttempts: 0,
        lockedUntil: null,
        lastLoginAt: expect.any(Date),
      });
    });
  });

  describe('lo que pasa cuando el hash guardado está corrupto', () => {
    it('lo trata como contraseña incorrecta, no como una caída', async () => {
      // `verify` LANZA si el hash no tiene formato válido: una fila
      // corrupta, una migración a medias, un valor editado a mano. Sin
      // el `.catch`, esa excepción subiría como un 500 y delataría que
      // la cuenta existe —los correos inexistentes seguirían dando 401—,
      // que es justo el oráculo de enumeración que el resto del diseño
      // evita. Falla CERRADO: nadie entra y nadie se entera de nada.
      const { s } = await servicio({ ...ADMIN, passwordHash: 'esto-no-es-un-hash' });
      mockArgon2.verify.mockRejectedValue(new Error('invalid hash format'));

      await expect(
        s.login('admin@detector.local', 'la-correcta'),
      ).rejects.toThrow('Credenciales inválidas');
    });
  });

  describe('hashPassword', () => {
    it('usa los parámetros de OWASP', async () => {
      // Es el que crea la primera cuenta en el arranque
      // (`admin-bootstrap.service.ts`). Si usara parámetros más flojos
      // que el resto, la cuenta del administrador inicial —la más
      // valiosa del sistema— sería la peor protegida.
      await AdminAuthService.hashPassword('una-contraseña');

      expect(mockArgon2.hash).toHaveBeenCalledWith('una-contraseña', {
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
    });
  });

  describe('findById', () => {
    it('no devuelve cuentas desactivadas', async () => {
      // Se consulta con isActive en el WHERE: desactivar a alguien tiene
      // que surtir efecto sin esperar a que caduque su token.
      const { s, prisma } = await servicio(ADMIN);

      await s.findById('admin-1');

      expect(prisma.adminUser.findFirst).toHaveBeenCalledWith({
        where: { id: 'admin-1', isActive: true },
      });
    });

    it('devuelve null cuando no hay nadie', async () => {
      const { s } = await servicio(null);

      await expect(s.findById('quien-sea')).resolves.toBeNull();
    });
  });
});
