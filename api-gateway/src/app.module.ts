import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AdminAccessPolicyController } from './admin/access-policy.controller';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthGuard } from './admin/admin-auth.guard';
import { AdminHandoversController } from './admin/handovers.controller';
import { AdminLogsController } from './admin/logs.controller';
import { AdminOperationsController } from './admin/operations.controller';
import { AdminPersonsController } from './admin/persons.controller';
import { AccessSessionGuard } from './auth/access-session.guard';
import { AuthController } from './auth/auth.controller';
import { MeController } from './auth/me.controller';
import { HealthController } from './health/health.controller';
import {
  AccessServiceClient,
  AuthServiceClient,
  FaceServiceClient,
  LogbookServiceClient,
  ShiftServiceClient,
  VoiceServiceClient,
} from './proxy/service-clients';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
        limit: Number(process.env.THROTTLE_LIMIT ?? 120),
      },
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'inseguro-solo-desarrollo'),
      }),
    }),
  ],
  controllers: [
    AuthController,
    MeController,
    AdminAuthController,
    AdminPersonsController,
    AdminAccessPolicyController,
    AdminOperationsController,
    AdminLogsController,
    AdminHandoversController,
    HealthController,
  ],
  providers: [
    FaceServiceClient,
    AccessServiceClient,
    AuthServiceClient,
    ShiftServiceClient,
    VoiceServiceClient,
    LogbookServiceClient,
    AdminAuthGuard,
    AccessSessionGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
