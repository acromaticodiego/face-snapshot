"""
Arranque de OpenTelemetry para el Vision Service.

POR QUE ESTE SERVICIO ES EL MAS INTERESANTE DE INSTRUMENTAR
───────────────────────────────────────────────────────────
Es el unico del sistema que hace trabajo de CPU pesado, y hasta ahora
solo sabia decir cuanto tardaba un frame entero. Eso no responde la
pregunta que de verdad importa: si el cuello de botella es el detector,
la alineacion o el embedding. Con un span por etapa, se responde
mirando.

Importa porque el umbral de similitud va ajustado —0.0641 de separacion
entre nubes segun el analisis con datos reales— y lo que hace falta no
es cambiar el numero, es mejorar la captura. Para saber cuanto margen
hay que gastar en una captura mejor, primero hay que saber en que se
gasta el tiempo ahora.

EL CONTEXTO DE TRAZA LLEGA SOLO
───────────────────────────────
El Face Service llama a este servicio por HTTP y arrastra la cabecera
`traceparent`. La instrumentacion de FastAPI la extrae sin que haya que
tocar nada, y por eso el tramo de Python aparece colgando del de Node en
la misma traza en lugar de como una traza suelta.
"""

from __future__ import annotations

import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# Un unico tracer para todo el servicio. Se pide aqui y no en cada
# modulo para que el nombre del instrumentador sea siempre el mismo.
tracer = trace.get_tracer("vision-service")


def configure_telemetry(app, *, service_version: str) -> bool:
    """
    Deja el servicio instrumentado. Devuelve si llego a activarse.

    Si no hay destino configurado, no se arranca nada y el servicio
    funciona exactamente igual. La telemetria nunca es un requisito
    para reconocer una cara.
    """
    if os.getenv("OTEL_SDK_DISABLED", "").lower() == "true":
        return False

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return False

    resource = Resource.create(
        {
            "service.name": "vision-service",
            "service.version": service_version,
            "deployment.environment.name": os.getenv(
                "OTEL_DEPLOYMENT_ENVIRONMENT", "local"
            ),
        }
    )

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(endpoint=f"{endpoint.rstrip('/')}/v1/traces")
        )
    )
    trace.set_tracer_provider(provider)

    # Import perezoso: sin destino configurado no se carga siquiera.
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(
        app,
        tracer_provider=provider,
        # La sonda de Docker pega aqui cada 30 s. Trazarla enterraria
        # bajo miles de trazas de una sonda las unicas que interesan,
        # que son las de alguien pasando por una puerta.
        excluded_urls="health,healthz,metrics",
    )

    return True
