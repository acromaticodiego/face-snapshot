import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { FaceClient } from './face/face.client';
import { HealthController } from './health/health.controller';
import { AccessLogsController } from './logs/access-logs.controller';
import { AccessLogsService } from './logs/access-logs.service';
import { OutboxRelay } from './outbox/outbox.relay';
import { PolicyController } from './policy/policy.controller';
import { PolicyRepository } from './policy/policy.repository';
import { PolicyService } from './policy/policy.service';
import { PassageService } from './presence/passage.service';
import { PresenceService } from './presence/presence.service';
import { PrismaService } from './prisma/prisma.service';
import { RedisModule } from './redis/redis.module';
import { VerificationController } from './verification/verification.controller';
import { VerificationService } from './verification/verification.service';
import {
  inMemoryVoteWindowStoreProvider,
  voteWindowStoreProvider,
} from './verification/vote-window.providers';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    RedisModule,
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
        // El límite es más alto que en el resto de servicios: la pantalla
        // de autenticación envía varios frames por segundo.
        limit: Number(process.env.THROTTLE_AUTH_LIMIT ?? 600),
      },
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32) {
          // Arrancar con un secreto débil convertiría los tokens de
          // sesión en falsificables. Mejor no arrancar.
          throw new Error(
            'JWT_SECRET no está definido o es demasiado corto (mínimo 32 caracteres). ' +
              'Genera uno con: openssl rand -base64 48',
          );
        }
        return { secret, signOptions: { issuer: 'access-service' } };
      },
    }),
  ],
  controllers: [
    VerificationController,
    PolicyController,
    AccessLogsController,
    HealthController,
  ],
  providers: [
    PrismaService,
    VerificationService,
    inMemoryVoteWindowStoreProvider,
    voteWindowStoreProvider,
    PolicyService,
    PolicyRepository,
    PresenceService,
    PassageService,
    OutboxRelay,
    AccessLogsService,
    FaceClient,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
