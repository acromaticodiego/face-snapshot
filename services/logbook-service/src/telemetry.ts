/**
 * Arranque de OpenTelemetry.
 *
 * TIENE QUE IMPORTARSE EL PRIMERO, ANTES QUE NADA
 * ───────────────────────────────────────────────
 * Las instrumentaciones funcionan parcheando modulos (`http`, `express`,
 * `pg`) en el momento en que se cargan. Si este archivo se
 * importa despues de que Nest haya cargado express, el parche llega
 * tarde y no se instrumenta nada: no falla, simplemente no aparece
 * ninguna traza, que es la forma mas dificil de depurar esto. Por eso
 * en `main.ts` es la primera linea y va separada del resto.
 *
 * POR QUE ESTE ARCHIVO ESTA REPETIDO EN LOS SEIS SERVICIOS NODE
 * ────────────────────────────────────────────────────────────
 * El ADR 0008 retiro el paquete de contratos compartido, y el motivo
 * era que compartir DTOs acopla despliegues: cambiar un campo obliga a
 * publicar y actualizar varios servicios a la vez. Aqui no hay ningun
 * contrato. Esto es configuracion de arranque, no una frontera entre
 * servicios, y las copias son iguales a proposito: el nombre y la
 * version salen del `package.json` de cada uno, asi que no hay nada
 * que cambiar entre ellas.
 *
 * La UNICA diferencia entre copias es que los servicios que no hablan
 * con Redis -el Logbook Service- no registran su instrumentacion. No
 * se deja por simetria porque seria arrastrar una dependencia que ese
 * servicio no usa solo para que dos archivos coincidan byte a byte.
 *
 * NO PUEDE TUMBAR EL SERVICIO
 * ───────────────────────────
 * Si el Collector no responde, el exportador descarta en silencio y
 * este proceso sigue atendiendo peticiones. Un sistema de
 * observabilidad que puede dejar a alguien fuera de un edificio esta
 * mal montado.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  ExpressInstrumentation,
  ExpressLayerType,
} from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

/**
 * Rutas cuyas peticiones NO generan traza.
 *
 * Docker sondea `/health` cada 30 s en cada servicio. Instrumentarlo
 * llenaria Tempo de trazas de una sonda y enterraria las unicas que
 * interesan, que son las de alguien pasando por una puerta. La regla
 * general: lo que pregunta una maquina en bucle no se traza.
 */
const RUTAS_SIN_TRAZA = ['/api/v1/health', '/health', '/metrics', '/favicon.ico'];

function iniciar(): void {
  if (process.env.OTEL_SDK_DISABLED === 'true') return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    // Sin destino no se arranca nada. Es lo que permite levantar el
    // stack sin observabilidad sin tocar una sola linea de codigo.
    return;
  }

  if (process.env.OTEL_DIAG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  // La identidad sale del package.json del propio servicio: es lo que
  // permite que este archivo sea identico en los cinco.
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { name: string; version: string };

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: pkg.name,
      [ATTR_SERVICE_VERSION]: pkg.version,
      'deployment.environment.name':
        process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),

    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),

    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        // 15 s, igual que el intervalo de raspado de Prometheus.
        // Exportar mas a menudo no daria ni un dato mas y si mas
        // trafico. El tiempo de espera no puede superar al intervalo, o
        // el SDK avisa y lo recorta por su cuenta.
        exportIntervalMillis: 15_000,
        exportTimeoutMillis: 10_000,
      }),
    ],

    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (peticion) =>
          RUTAS_SIN_TRAZA.some((ruta) => peticion.url?.startsWith(ruta) ?? false),
      }),
      new ExpressInstrumentation({
        // Sin esto, cada peticion arrastra cinco spans de cero
        // milisegundos —cors, helmet, el parser de JSON, el de
        // urlencoded— que no describen ninguna operacion y solo
        // estorban al leer la traza. Lo que interesa de Express es el
        // manejador de la ruta, y ese se conserva.
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
      }),
      // Pone el nombre del controlador y del metodo en el span, que es
      // la diferencia entre "algo tardo 300 ms en el Access Service" y
      // "VerificationController.verifyFrame tardo 300 ms".
      new NestInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  sdk.start();

  // Al apagar hay que VACIAR lo pendiente. Sin esto, los spans del
  // ultimo tramo se quedan en el buffer y se pierden justo cuando mas
  // falta hacen: investigando por que se reinicio el servicio.
  const apagar = () => {
    void sdk
      .shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', apagar);
  process.once('SIGINT', apagar);
}

iniciar();
