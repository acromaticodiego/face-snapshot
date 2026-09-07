import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { FacesService } from './faces/faces.service';
import { FacesRepository } from './faces/faces.repository';
import { RecognitionController } from './faces/recognition.controller';
import { HealthController } from './health/health.controller';
import { PersonsController } from './persons/persons.controller';
import { PersonsService } from './persons/persons.service';
import { PrismaService } from './prisma/prisma.service';
import { VisionClient } from './vision/vision.client';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
        limit: Number(process.env.THROTTLE_LIMIT ?? 120),
      },
    ]),
  ],
  controllers: [PersonsController, RecognitionController, HealthController],
  providers: [
    PrismaService,
    PersonsService,
    FacesService,
    FacesRepository,
    VisionClient,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
