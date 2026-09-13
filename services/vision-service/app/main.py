"""
Vision Service — punto de entrada.

Microservicio sin estado que convierte imágenes en vectores faciales.
No tiene base de datos y no conoce identidades.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.routes import router as v1_router
from app.core.config import get_settings
from app.core.errors import VisionError, vision_error_handler
from app.core.logging import configure_logging, get_logger
from app.core.telemetry import configure_telemetry
from app.detection.factory import build_detector
from app.recognition.aligner import FaceAligner
from app.recognition.embedder import ArcFaceEmbedder
from app.services.face_pipeline import FacePipeline

settings = get_settings()
configure_logging(settings.log_level)
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Los modelos se cargan UNA vez al arrancar, no por petición.

    Cargar ArcFace en cada request añadiría segundos de latencia; hacerlo
    aquí mantiene el reconocimiento en decenas de milisegundos.
    """
    logger.info("arrancando", backend=settings.detector_backend)

    pipeline = FacePipeline(
        detector=build_detector(settings),
        aligner=FaceAligner(model_pack=settings.insightface_pack),
        embedder=ArcFaceEmbedder(model_pack=settings.insightface_pack),
        settings=settings,
    )
    pipeline.load()

    app.state.pipeline = pipeline
    app.state.settings = settings
    logger.info("modelos_listos", **pipeline.model_info.model_dump())

    yield

    logger.info("apagando")


app = FastAPI(
    title="Vision Service",
    description=(
        "Detección facial con rostros.pt (YOLOv8s) y generación de "
        "embeddings con ArcFace. Servicio interno y sin estado."
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

app.add_exception_handler(VisionError, vision_error_handler)
app.include_router(v1_router, prefix="/api/v1")

# Se instrumenta despues de montar las rutas para que los spans lleven
# el patron de ruta (`/api/v1/analyze`) en lugar de la URL concreta.
if configure_telemetry(app, service_version=app.version):
    logger.info("telemetria_activa", endpoint=os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"])


@app.get("/", include_in_schema=False)
async def root():
    return {"service": settings.service_name, "docs": "/docs"}
