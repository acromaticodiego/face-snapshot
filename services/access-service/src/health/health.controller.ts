import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OutboxRelay } from '../outbox/outbox.relay';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT, type OptionalRedis } from '../redis/redis.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRelay,
    @Inject(REDIS_CLIENT) private readonly redis: OptionalRedis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio' })
  async check() {
    const database = await this.prisma
      .$queryRaw`SELECT 1`
      .then(() => 'ok')
      .catch(() => 'unreachable');

    // Redis no cuenta para el estado general a proposito: sin el, la
    // votacion degrada a memoria y los eventos esperan en la outbox,
    // pero las puertas siguen abriendose. Marcar el servicio como caido
    // por eso haria que un orquestador lo reiniciara sin necesidad.
    const bus = !this.redis
      ? 'disabled'
      : await this.redis
          .ping()
          .then(() => 'ok')
          .catch(() => 'unreachable');

    // La cola pendiente si es la senal que hay que vigilar: si crece,
    // los turnos y la presencia del panel se estan quedando atras.
    const outbox =
      database === 'ok'
        ? await this.outbox.backlog().catch(() => null)
        : null;

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'access-service',
      dependencies: { database, bus },
      ...(outbox ? { outbox } : {}),
    };
  }
}
