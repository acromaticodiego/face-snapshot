import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { AdminAuthService } from './admin-auth.service';

/**
 * Crea la primera cuenta de administración si la tabla está vacía.
 *
 * Sin esto habría un problema del huevo y la gallina: las rutas de
 * administración exigen un administrador, y crear administradores es una
 * ruta de administración.
 *
 * Solo actúa cuando NO existe ninguna cuenta. En cuanto hay una, este
 * servicio no vuelve a tocar nada: no puede sobrescribir contraseñas ni
 * reactivar cuentas desactivadas.
 */
/** Misma regla que usa el endpoint de login. */
const EmailSchema = z.string().trim().email().max(160);

@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const existing = await this.prisma.adminUser.count();
    if (existing > 0) return;

    const email = this.config
      .get<string>('ADMIN_BOOTSTRAP_EMAIL', 'admin@detector.local')
      .trim()
      .toLowerCase();
    const password = this.config.get<string>('ADMIN_BOOTSTRAP_PASSWORD');

    // El correo debe superar la MISMA validación que aplica el inicio de
    // sesión. Sin esta comprobación se podría crear una cuenta que luego
    // ningún formulario acepta: quedaría inutilizable y el sistema, sin
    // ningún administrador que pudiera entrar.
    if (!EmailSchema.safeParse(email).success) {
      this.logger.error(
        `ADMIN_BOOTSTRAP_EMAIL="${email}" no es una direccion valida, y el ` +
          'inicio de sesion la rechazaria. Corrigela en .env y reinicia. ' +
          'Sugerencia: admin@detector.local',
      );
      return;
    }

    if (!password || password.length < 12) {
      // Arrancar creando una cuenta con contraseña débil sería peor que
      // no crearla: quedaría abierta sin que nadie se diese cuenta.
      this.logger.error(
        'No hay ninguna cuenta de administración y ADMIN_BOOTSTRAP_PASSWORD ' +
          'no está definida o tiene menos de 12 caracteres. ' +
          'Defínela en .env y reinicia este servicio.',
      );
      return;
    }

    await this.prisma.adminUser.create({
      data: {
        email,
        passwordHash: await AdminAuthService.hashPassword(password),
        displayName: this.config.get<string>(
          'ADMIN_BOOTSTRAP_NAME',
          'Administrador',
        ),
        role: 'OWNER',
      },
    });

    // Se registra el correo, nunca la contraseña.
    this.logger.warn(
      `Cuenta de administración inicial creada para "${email}". ` +
        'Cambia la contraseña y retira ADMIN_BOOTSTRAP_PASSWORD del entorno.',
    );
  }
}
