"""
Arranque de OpenTelemetry para el Voice Service.

QUE APORTA AQUI, QUE NO ES LO MISMO QUE EN EL VISION SERVICE
────────────────────────────────────────────────────────────
El Vision Service se instrumento para repartir el tiempo entre etapas
de CPU propias. Aqui casi todo el tiempo se va ESPERANDO A TERCEROS: un
span por proveedor responde quien tarda y quien falla, que es la unica
pregunta interesante cuando el trabajo lo hace otro.

Importa porque los dos proveedores fallan de forma distinta y la
degradacion tambien es distinta: sin Deepgram no hay nada que
estructurar, y sin Gemini queda la transcripcion, que ya sirve. Sin
medir por separado no se puede distinguir "Gemini va lento" de "el
audio era largo".

LA MISMA REGLA QUE EN TODO EL PROYECTO
──────────────────────────────────────
Sin destino configurado no se arranca nada y el servicio funciona
igual. La telemetria no es dependencia de nadie.
"""

from __future__ import annotations

import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

tracer = trace.get_tracer("voice-service")


def configure_telemetry(app, *, service_version: str) -> bool:
    """Deja el servicio instrumentado. Devuelve si llego a activarse."""
    if os.getenv("OTEL_SDK_DISABLED", "").lower() == "true":
        return False

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return False

    resource = Resource.create(
        {
            "service.name": "voice-service",
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

    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(
        app,
        tracer_provider=provider,
        # Igual que en el Vision Service: la sonda de Docker pega cada
        # 30 s y trazarla enterraria lo que interesa.
        excluded_urls="health,healthz,metrics",
    )

    return True
