import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthService } from './admin/admin-auth.service';
import { AdminBootstrapService } from './admin/admin-bootstrap.service';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
        limit: Number(process.env.THROTTLE_LIMIT ?? 60),
      },
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32) {
          // Con un secreto débil, cualquiera podría fabricarse un token
          // de administrador. Mejor no arrancar que arrancar inseguro.
          throw new Error(
            'JWT_SECRET no está definido o es demasiado corto (mínimo 32 caracteres). ' +
              'Genera uno con: openssl rand -base64 48',
          );
        }
        return { secret, signOptions: { issuer: 'auth-service' } };
      },
    }),
  ],
  controllers: [AdminAuthController, HealthController],
  providers: [
    PrismaService,
    AdminAuthService,
    AdminBootstrapService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
