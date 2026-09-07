import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Parámetros de argon2id.
 *
 * Siguen la recomendación de OWASP: 19 MiB de memoria, 2 iteraciones y
 * paralelismo 1. El coste en memoria es lo que hace cara la fuerza
 * bruta con GPU, donde la memoria (y no el cálculo) es el cuello de
 * botella.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface AdminIdentity {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);
  /**
   * Duración del token de administración.
   *
   * `jsonwebtoken` tipa `expiresIn` como un literal de plantilla
   * ('8h', '30m'...), no como un `string` cualquiera. El valor llega de
   * una variable de entorno, así que se estrecha el tipo en este único
   * punto en lugar de repetir el cast en cada firma.
   */
  private readonly tokenTtl: NonNullable<JwtSignOptions['expiresIn']>;

  /**
   * Hash de descarte para cuando el correo no existe.
   *
   * Se verifica contra él para que la respuesta tarde lo mismo exista o
   * no la cuenta. Sin esto, un atacante enumera qué correos son
   * administradores midiendo el tiempo de respuesta: los inexistentes
   * contestarían al instante y los válidos tras calcular argon2.
   *
   * Se genera al arrancar, con los MISMOS parámetros que los hashes
   * reales, para que el coste de verificarlo sea idéntico. Un literal
   * escrito a mano correría el riesgo de ser inválido y hacer que
   * `verify` fallase de inmediato, que es justo lo que se quiere evitar.
   */
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.tokenTtl = config.get<string>(
      'ADMIN_TOKEN_EXPIRES_IN',
      '8h',
    ) as NonNullable<JwtSignOptions['expiresIn']>;
  }

  async onModuleInit(): Promise<void> {
    const filler = randomBytes(32).toString('hex');
    this.dummyHash = await hash(filler, ARGON2_OPTIONS);
  }

  static hashPassword(plain: string): Promise<string> {
    return hash(plain, ARGON2_OPTIONS);
  }

  /**
   * Valida credenciales y emite el token de administración.
   *
   * El mensaje de error es SIEMPRE el mismo, exista la cuenta o no, esté
   * desactivada o sea la contraseña la incorrecta. Distinguirlos
   * permitiría enumerar qué correos son administradores del sistema.
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; expiresIn: string; admin: AdminIdentity }> {
    const normalizedEmail = email.trim().toLowerCase();

    const admin = await this.prisma.adminUser.findUnique({
      where: { email: normalizedEmail },
    });

    // Cuenta bloqueada temporalmente por intentos fallidos.
    if (admin?.lockedUntil && admin.lockedUntil > new Date()) {
      this.logger.warn(`Intento sobre cuenta bloqueada: ${normalizedEmail}`);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Se verifica siempre un hash, aunque la cuenta no exista, para que
    // el tiempo de respuesta no delate su existencia.
    const passwordMatches = await verify(
      admin?.passwordHash ?? this.dummyHash,
      password,
    ).catch(() => false);

    if (!admin || !admin.isActive || !passwordMatches) {
      if (admin) await this.registerFailedAttempt(admin.id, admin.failedAttempts);
      // El correo se registra, la contraseña JAMÁS.
      this.logger.warn(`Inicio de sesión fallido: ${normalizedEmail}`);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date(), failedAttempts: 0, lockedUntil: null },
    });

    const identity: AdminIdentity = {
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      role: admin.role,
    };

    const accessToken = await this.jwt.signAsync(
      {
        sub: admin.id,
        email: admin.email,
        name: admin.displayName,
        role: admin.role,
        // Este campo es lo que impide que el token de sesión que recibe
        // una persona reconocida sirva para administrar el sistema.
        typ: 'admin',
      },
      { expiresIn: this.tokenTtl },
    );

    this.logger.log(`Inicio de sesión correcto: ${admin.email}`);
    return { accessToken, expiresIn: String(this.tokenTtl), admin: identity };
  }

  private async registerFailedAttempt(
    adminId: string,
    currentFailures: number,
  ): Promise<void> {
    const attempts = currentFailures + 1;
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;

    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        failedAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock
          ? new Date(Date.now() + LOCK_DURATION_MS)
          : null,
      },
    });

    if (shouldLock) {
      this.logger.warn(
        `Cuenta bloqueada 15 minutos tras ${MAX_FAILED_ATTEMPTS} intentos fallidos`,
      );
    }
  }

  async findById(id: string): Promise<AdminIdentity | null> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id, isActive: true },
    });
    if (!admin) return null;
    return {
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      role: admin.role,
    };
  }
}
