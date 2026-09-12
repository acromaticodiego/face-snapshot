import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AccessEventsConsumer } from './consumer/access-events.consumer';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';
import { RedisModule } from './redis/redis.module';
import { ShiftReconciler } from './shifts/shift.reconciler';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsQuery } from './shifts/shifts.query';
import { ShiftsService } from './shifts/shifts.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    RedisModule,
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
        limit: Number(process.env.THROTTLE_LIMIT ?? 120),
      },
    ]),
  ],
  controllers: [ShiftsController, HealthController],
  providers: [
    PrismaService,
    ShiftsService,
    ShiftsQuery,
    ShiftReconciler,
    AccessEventsConsumer,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
