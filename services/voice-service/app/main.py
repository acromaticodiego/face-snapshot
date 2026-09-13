"""
Voice Service — punto de entrada.

Microservicio sin estado, simetrico al Vision Service: convierte audio
en texto estructurado. No tiene base de datos y no conoce identidades.

LA ASIMETRIA QUE HAY QUE DECIR EN VOZ ALTA
──────────────────────────────────────────
El resto del sistema presume, con razon, de que los datos biometricos
no salen del backend: los embeddings faciales no cruzan la frontera y
las imagenes no se guardan. Este servicio ROMPE esa propiedad: manda
audio a Deepgram y texto a Google, y la voz tambien es un dato
biometrico.

Es una decision consciente y tiene contrapartidas -el audio no se
almacena en ningun sitio, ni aqui ni en disco-, pero no se puede seguir
diciendo que ningun dato biometrico sale del sistema. Queda escrito
aqui para que nadie lo descubra leyendo el codigo.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.routes import router as v1_router
from app.core.config import get_settings
from app.core.errors import VoiceError, voice_error_handler
from app.core.logging import configure_logging, get_logger
from app.core.telemetry import configure_telemetry
from app.providers.deepgram import DeepgramTranscriber
from app.providers.gemini import GeminiStructurer
from app.services.logbook_draft import LogbookDraftService

settings = get_settings()
configure_logging(settings.log_level)
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Aqui no hay modelos que cargar, y por eso arranca en milisegundos.

    Es la diferencia de fondo con el Vision Service: aquel tarda en
    levantarse porque carga ArcFace y el detector en memoria; este solo
    prepara dos clientes HTTP. Todo el trabajo pesado lo hace otro, al
    otro lado de la red.
    """
    app.state.settings = settings
    app.state.draft = LogbookDraftService(
        transcriber=DeepgramTranscriber(settings),
        structurer=GeminiStructurer(settings),
        settings=settings,
    )

    # Se avisa al arrancar de lo que NO va a funcionar, en vez de
    # esperar a que alguien dicte un parte para descubrirlo.
    if not settings.transcription_configured:
        logger.warning("sin_clave_de_transcripcion", efecto="no se podra transcribir")
    if not settings.structuring_configured:
        logger.warning(
            "sin_clave_de_estructuracion",
            efecto="los partes llegaran solo como transcripcion",
        )

    logger.info(
        "listo",
        transcripcion=settings.deepgram_model,
        estructuracion=settings.gemini_model,
    )

    yield

    logger.info("apagando")


app = FastAPI(
    title="Voice Service",
    description=(
        "Transcripcion con Deepgram y estructuracion con Gemini para la "
        "bitacora de relevo de turno. Servicio interno y sin estado. "
        "Todo lo que devuelve es un BORRADOR que revisa una persona."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.add_exception_handler(VoiceError, voice_error_handler)
app.include_router(v1_router, prefix="/api/v1")

# Despues de montar las rutas, para que los spans lleven el patron de
# ruta y no la URL concreta.
if configure_telemetry(app, service_version=app.version):
    logger.info("telemetria_activa", endpoint=os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"])


@app.get("/", include_in_schema=False)
async def root():
    return {"service": settings.service_name, "docs": "/docs"}
