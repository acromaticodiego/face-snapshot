import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { context, metrics } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

import { REDIS_CLIENT, type OptionalRedis } from '../redis/redis.module';

const CONSUMER_GROUP = 'shift-service';

/**
 * Cuanto se esta retrasando el consumidor.
 *
 * POR QUE ESTO NO SE VE DE NINGUNA OTRA FORMA
 * ───────────────────────────────────────────
 * Este servicio es una PROYECCION: si se atasca, no falla nada visible.
 * Las puertas siguen abriendo, el Access Service responde igual, la
 * outbox se vacia sin problema y ninguna peticion da error. Lo unico
 * que ocurre es que la jornada de la gente se queda congelada en un
 * momento del pasado, y eso solo se descubre cuando alguien mira su
 * hoja de horas.
 *
 * Justamente porque fallar aqui es inofensivo para las puertas, es lo
 * que mas facil resulta no enterarse de que esta roto. De ahi la
 * metrica.
 *
 * QUE MIDE EXACTAMENTE
 * ────────────────────
 * El tamano de la PEL: mensajes entregados al grupo y todavia sin
 * confirmar. Un valor que sube y no baja significa que los eventos se
 * estan entregando pero algo impide escribirlos —la base de datos, un
 * fallo de la maquina de estados—, y esos mensajes acabaran
 * reclamandose por tiempo una y otra vez.
 *
 * No mide lo mismo que la antiguedad de la outbox del Access Service,
 * y hacen falta las dos: aquella dice "no sale del emisor", esta dice
 * "sale pero no se consume". Son dos averias distintas con dos
 * arreglos distintos.
 */
@Injectable()
export class ConsumerMetrics {
  private readonly logger = new Logger(ConsumerMetrics.name);
  private readonly stream: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: OptionalRedis,
    config: ConfigService,
  ) {
    this.stream = config.get<string>('ACCESS_EVENTS_STREAM', 'access.events');
    this.registrar();
  }

  private registrar(): void {
    if (!this.redis) return;

    const meter = metrics.getMeter('shift-service');

    const pendientes = meter.createObservableGauge(
      'shift_consumidor_pendientes',
      {
        description:
          'Eventos entregados al grupo de consumidores y sin confirmar (PEL)',
      },
    );

    pendientes.addCallback(async (resultado) => {
      try {
        // En segundo plano y cada quince segundos: no se traza, por el
        // mismo motivo que no se traza la espera del consumidor.
        const respuesta = await context.with(
          suppressTracing(context.active()),
          () => this.redis!.xpending(this.stream, CONSUMER_GROUP),
        );

        // XPENDING en su forma corta devuelve
        // [total, menorId, mayorId, [[consumidor, cuenta], ...]].
        const total = Array.isArray(respuesta) ? Number(respuesta[0] ?? 0) : 0;
        resultado.observe(total);
      } catch (error) {
        // NOGROUP es lo normal antes de que nadie haya pasado por una
        // puerta: el grupo aun no existe. No es una averia y no merece
        // un aviso en cada ventana de medicion.
        const mensaje = (error as Error).message;
        if (!mensaje.includes('NOGROUP')) {
          this.logger.warn(`No se pudo medir el retraso: ${mensaje}`);
        }
      }
    });
  }
}
