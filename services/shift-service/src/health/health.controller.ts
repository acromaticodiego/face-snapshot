import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../prisma/prisma.service';
import { REDIS_PROBE, type OptionalRedis } from '../redis/redis.module';

/**
 * Cuanto se espera al bus antes de darlo por caido.
 *
 * Holgado para una red local y muy por debajo de cualquier sonda
 * razonable de orquestador.
 */
const PING_TIMEOUT_MS = 2_000;

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_PROBE) private readonly redis: OptionalRedis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio' })
  async check() {
    const database = await this.prisma
      .$queryRaw`SELECT 1`
      .then(() => 'ok')
      .catch(() => 'unreachable');

    // Aqui Redis SI cuenta para el estado, al reves que en el Access
    // Service: sin bus, este servicio no recibe eventos y su unica
    // razon de ser -que la jornada avance- deja de cumplirse. Que se
    // note es lo correcto.
    //
    // EL PING VA POR UNA CONEXION APARTE, Y ESO SI ES UN DETALLE
    // ----------------------------------------------------------
    // La conexion principal esta dentro de un `XREADGROUP ... BLOCK`
    // casi todo el tiempo, y Redis atiende los comandos de una misma
    // conexion EN ORDEN: un `ping` por ese socket se encola detras del
    // bloqueo. Esta sonda decia «bus inalcanzable» con Redis sano 5 de
    // cada 8 veces antes de separarlas.
    //
    // La conexion de la sonda ademas NO reintenta indefinidamente ni
    // guarda el comando en cola: tiene que responder rapido y decir la
    // verdad, aunque la verdad sea que no hay bus. El plazo de abajo
    // se queda como ultima red.
    //
    // Un /health colgado es peor que uno que informa del fallo: la
    // sonda del orquestador agota su tiempo y el servicio parece
    // muerto en vez de degradado, con lo que acaba reiniciado sin
    // necesidad.
    const bus = !this.redis ? 'disabled' : await this.pingBus();

    const healthy = database === 'ok' && bus === 'ok';

    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'shift-service',
      dependencies: { database, bus },
    };
  }

  /** `PING` con plazo: pasado el tiempo se da por inalcanzable. */
  private async pingBus(): Promise<'ok' | 'unreachable'> {
    const timeout = new Promise<'unreachable'>((resolve) =>
      setTimeout(() => resolve('unreachable'), PING_TIMEOUT_MS).unref?.(),
    );

    const ping = this.redis!.ping()
      .then(() => 'ok' as const)
      .catch(() => 'unreachable' as const);

    return Promise.race([ping, timeout]);
  }
}
