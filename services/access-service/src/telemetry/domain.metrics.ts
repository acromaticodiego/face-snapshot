import { Injectable, Logger } from '@nestjs/common';
import { context, metrics } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Metricas de DOMINIO del Access Service.
 *
 * POR QUE ESTAS Y NO OTRAS
 * ────────────────────────
 * El colector ya fabrica solo las metricas RED —peticiones, errores,
 * latencia— a partir de las trazas. Duplicarlas aqui seria trabajo
 * inutil y, peor, dos numeros que acabarian sin cuadrar.
 *
 * Lo que queda son las que NINGUNA traza puede dar, porque no hablan
 * de peticiones sino del estado del sistema:
 *
 *   · por que se deniega. Una traza dice que la peticion fue bien; no
 *     dice que se denego el paso por horario. Operativamente son cosas
 *     opuestas: la peticion correcta y la persona en la calle.
 *   · cuanta similitud hubo. Es el numero del que depende el umbral, y
 *     el margen medido es de 0.0641.
 *   · si el bus se esta atascando. Esto es lo mas importante de la
 *     lista, y se explica abajo.
 *
 * EL PANEL YA ENSENA ALGUNAS DE ESTAS COSAS, Y NO SOBRA
 * ────────────────────────────────────────────────────
 * El panel de operacion las calcula en SQL sobre el historico y sirve
 * para mirar lo que paso. Estas sirven para ALERTAR y para ver
 * tendencia sin castigar la base de datos con una agregacion por cada
 * refresco. No sustituyen al panel ni al reves.
 */
@Injectable()
export class DomainMetrics {
  private readonly logger = new Logger(DomainMetrics.name);

  private readonly decisiones = metrics
    .getMeter('access-service')
    .createCounter('acceso_decisiones', {
      description: 'Decisiones de acceso, desglosadas por motivo',
    });

  private readonly similitud = metrics
    .getMeter('access-service')
    .createHistogram('acceso_similitud', {
      description:
        'Similitud coseno del mejor candidato en cada frame con rostro',
      // Los limites se aprietan alrededor del umbral (0.38) porque es
      // donde se decide. Fuera de esa franja da igual si algo marco
      // 0.02 o 0.05: en ambos casos es un desconocido.
      advice: {
        explicitBucketBoundaries: [
          0.0, 0.1, 0.2, 0.3, 0.34, 0.38, 0.42, 0.5, 0.6, 0.7, 0.8, 0.9,
        ],
      },
    });

  constructor(private readonly prisma: PrismaService) {
    this.registrarObservables();
  }

  /** Una decision tomada. `motivo` es el enum `AccessReason`. */
  registrarDecision(motivo: string, sede: string, zona: string): void {
    this.decisiones.add(1, { motivo, sede, zona });
  }

  /**
   * La similitud del mejor candidato de un frame.
   *
   * Solo se llama cuando hubo un rostro que comparar: registrar un 0
   * por cada frame sin cara desplazaria la distribucion entera hacia
   * abajo y el histograma dejaria de decir nada sobre el umbral.
   */
  registrarSimilitud(valor: number): void {
    this.similitud.record(valor);
  }

  /**
   * Medidores que se leen preguntando, no acumulando.
   *
   * POR QUE ESTOS DOS SON LOS QUE DE VERDAD HACEN FALTA
   * ──────────────────────────────────────────────────
   * La outbox garantiza que ningun paso se pierde, pero no garantiza
   * que salga PRONTO. Si Redis deja de aceptar escrituras, las filas
   * se acumulan y todo sigue aparentemente bien: las puertas abren, el
   * Gateway responde, ninguna peticion falla. Lo unico que pasa es que
   * las horas de la gente dejan de computarse, en silencio, hasta que
   * alguien mira su hoja al final del mes.
   *
   * De los dos, el que importa es la ANTIGUEDAD. El numero de
   * pendientes sube y baja con el trafico y no distingue "hay mucha
   * gente entrando" de "esto lleva parado media hora"; la antiguedad
   * del mas viejo sin publicar solo crece cuando algo va mal.
   */
  private registrarObservables(): void {
    const meter = metrics.getMeter('access-service');

    const pendientes = meter.createObservableGauge('outbox_eventos_pendientes', {
      description: 'Eventos escritos en la outbox y todavia sin publicar',
    });

    const retraso = meter.createObservableGauge('outbox_retraso_segundos', {
      description:
        'Antiguedad del evento sin publicar mas viejo. Cero si no hay ninguno',
    });

    meter.addBatchObservableCallback(
      async (resultado) => {
        try {
          // Estas consultas corren cada quince segundos en segundo
          // plano. Sin suprimir el trazado serian casi seis mil trazas
          // raiz al dia que solo dicen "sigue habiendo cero
          // pendientes". La regla es la misma que en el relay: lo que
          // pregunta un temporizador en bucle no se traza.
          const [fila] = await context.with(
            suppressTracing(context.active()),
            () =>
              this.prisma.$queryRaw<
                { pendientes: bigint; antiguedad: number | null }[]
              >`
                SELECT
                  COUNT(*) AS pendientes,
                  EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) AS antiguedad
                FROM access_svc.outbox_events
                WHERE published_at IS NULL
              `,
          );

          resultado.observe(pendientes, Number(fila?.pendientes ?? 0));
          resultado.observe(retraso, Number(fila?.antiguedad ?? 0));
        } catch (error) {
          // Un fallo midiendo no puede convertirse en un fallo del
          // servicio. Se anota y la serie se queda sin dato en esa
          // ventana, que es lo correcto: mejor un hueco en el grafico
          // que un numero inventado.
          this.logger.warn(
            `No se pudo medir el estado de la outbox: ${(error as Error).message}`,
          );
        }
      },
      [pendientes, retraso],
    );
  }
}
