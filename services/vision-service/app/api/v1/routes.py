"""
Endpoints del Vision Service.

Este servicio es INTERNO: solo debe ser accesible desde el Face Service.
No se expone al navegador, porque sus respuestas contienen embeddings.
"""

from __future__ import annotations

import cv2
import numpy as np
from fastapi import APIRouter, File, Request, UploadFile
from starlette.concurrency import run_in_threadpool

from app.core.errors import ImageTooLargeError, InvalidImageError
from app.schemas.vision import (
    HealthResponse,
    VisionAnalyzeResponse,
    VisionDetectOnlyResponse,
)

router = APIRouter()

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}


# ══════════════════════════════════════════════════════════════════
#  POR QUE LA INFERENCIA NO PUEDE CORRER EN EL BUCLE DE EVENTOS
#
#  Estos manejadores son `async def`, asi que FastAPI los ejecuta EN
#  el bucle de eventos. El pipeline, en cambio, es trabajo de CPU
#  bloqueante: unos 750 ms por frame. Llamarlo directamente desde aqui
#  congela el bucle entero mientras dura, y con el se congela todo lo
#  demas que el proceso tenga que atender.
#
#  Lo que eso costaba, medido antes de este cambio:
#
#      /health en reposo ................     1 ms
#      /health con 4 frames en vuelo ....  3077 ms
#
#  El HEALTHCHECK de Docker tiene un plazo de 5 s. Con ocho frames
#  encolados lo supera, Docker marca el contenedor como enfermo y lo
#  reinicia, perdiendo los modelos cargados. Carga -> reinicio -> mas
#  carga: exactamente la forma de fallar que convierte un pico de
#  trafico en una caida.
#
#  Es la misma leccion que ya dejo el /health del Shift Service con
#  Redis caido: una sonda nunca debe poder colgarse.
#
#  `run_in_threadpool` saca el trabajo pesado a un hilo aparte y deja
#  el bucle libre para responder. No es una optimizacion de
#  rendimiento: es lo que impide que el servicio se autodestruya bajo
#  carga.
# ══════════════════════════════════════════════════════════════════


async def _read_image(request: Request, file: UploadFile) -> np.ndarray:
    """Valida y decodifica la imagen subida."""
    settings = request.app.state.settings

    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise InvalidImageError(
            f"Tipo no permitido: {file.content_type}. "
            f"Se aceptan: {', '.join(sorted(ALLOWED_CONTENT_TYPES))}"
        )

    payload = await file.read()
    if len(payload) > settings.max_image_bytes:
        raise ImageTooLargeError(
            f"La imagen supera el límite de {settings.max_image_size_mb} MB"
        )
    if not payload:
        raise InvalidImageError("El archivo está vacío")

    # No confiamos en el content-type declarado: decodificamos de verdad.
    buffer = np.frombuffer(payload, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise InvalidImageError("No se pudo decodificar la imagen")

    return image


@router.get("/health", response_model=HealthResponse, tags=["health"])
async def health(request: Request) -> HealthResponse:
    pipeline = request.app.state.pipeline
    settings = request.app.state.settings
    return HealthResponse(
        status="ok" if pipeline.is_ready else "loading",
        service=settings.service_name,
        detectorReady=pipeline.detector_ready,
        embedderReady=pipeline.embedder_ready,
        spoofReady=pipeline.spoof_ready,
        detectorBackend=settings.detector_backend,
        embeddingModel=settings.embedding_model_name,
        embeddingDim=settings.embedding_dim,
    )


@router.post("/faces/detect", response_model=VisionDetectOnlyResponse, tags=["faces"])
async def detect_faces(
    request: Request, file: UploadFile = File(...)
) -> VisionDetectOnlyResponse:
    """
    Solo cajas, sin embeddings.

    Pensado para previsualización: permite encuadrar el rostro sin
    generar ni mover datos biométricos.
    """
    image = await _read_image(request, file)
    return await run_in_threadpool(request.app.state.pipeline.detect_only, image)


@router.post("/faces/analyze", response_model=VisionAnalyzeResponse, tags=["faces"])
async def analyze_faces(
    request: Request, file: UploadFile = File(...)
) -> VisionAnalyzeResponse:
    """
    Detección + embedding de cada rostro.

    ATENCION: la respuesta contiene vectores biométricos. Solo debe
    consumirla el Face Service, nunca el navegador.
    """
    image = await _read_image(request, file)
    return await run_in_threadpool(request.app.state.pipeline.analyze, image)
