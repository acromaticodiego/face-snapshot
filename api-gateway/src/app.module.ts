import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AdminAuthGuard } from './admin/admin-auth.guard';
import { AdminLogsController } from './admin/logs.controller';
import { AdminPersonsController } from './admin/persons.controller';
import { AuthController } from './auth/auth.controller';
import { HealthController } from './health/health.controller';
import {
  AccessServiceClient,
  FaceServiceClient,
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
    AdminPersonsController,
    AdminLogsController,
    HealthController,
  ],
  providers: [
    FaceServiceClient,
    AccessServiceClient,
    AdminAuthGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
