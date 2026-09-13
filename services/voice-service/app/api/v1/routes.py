"""
Endpoints del Voice Service.

Este servicio es INTERNO, igual que el Vision Service: no se expone al
navegador. Quien lo llama comprueba los tokens antes, y aqui no se
repite esa verificacion porque este puerto no sale de la red de Docker.

NO CONOCE A NADIE
─────────────────
No recibe identificadores de persona, ni de sede, ni de turno. Recibe
audio y devuelve texto ordenado. Quien dicto el parte y a que jornada
pertenece lo sabe el servicio que guarda la bitacora, y esa separacion
es la misma que mantiene al Vision Service sin saber a quien pertenece
un rostro.
"""

from __future__ import annotations

from fastapi import APIRouter, File, Request, UploadFile

from app.core.errors import AudioTooLargeError, InvalidAudioError
from app.schemas.voice import (
    HealthResponse,
    LogbookDraftResponse,
    TranscriptionResponse,
)

router = APIRouter()

# Lo que el navegador produce con MediaRecorder -webm y ogg- mas los
# formatos habituales de un dictafono. No es una lista cerrada por
# capricho: el tipo se reenvia tal cual a Deepgram, asi que aceptar
# cualquier cosa seria dejar que un cliente eligiera que le mandamos a
# un tercero.
ALLOWED_CONTENT_TYPES = {
    "audio/webm",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/mpeg",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/flac",
}


async def _leer_audio(request: Request, file: UploadFile) -> tuple[bytes, str]:
    settings = request.app.state.settings

    # El navegador anade a veces los parametros del codec
    # ("audio/webm;codecs=opus"). Se compara solo el tipo.
    declarado = (file.content_type or "").split(";")[0].strip().lower()
    if declarado not in ALLOWED_CONTENT_TYPES:
        raise InvalidAudioError(
            f"Tipo no permitido: {file.content_type or 'sin declarar'}. "
            f"Se aceptan: {', '.join(sorted(ALLOWED_CONTENT_TYPES))}"
        )

    payload = await file.read()
    if len(payload) > settings.max_audio_bytes:
        raise AudioTooLargeError(
            f"El audio supera el limite de {settings.max_audio_size_mb} MB"
        )
    if not payload:
        raise InvalidAudioError("El archivo esta vacio")

    return payload, declarado


@router.get("/health", response_model=HealthResponse, tags=["health"])
async def health(request: Request) -> HealthResponse:
    settings = request.app.state.settings
    draft = request.app.state.draft
    return HealthResponse(
        # El servicio esta sano aunque no pueda transcribir: lo unico
        # que lo dejaria enfermo seria no poder arrancar. Que falte una
        # clave es un problema de configuracion del despliegue, y
        # marcarlo como enfermo haria que Docker reiniciara el
        # contenedor en bucle sin arreglar nada.
        status="ok",
        service=settings.service_name,
        transcriptionConfigured=draft is not None
        and settings.transcription_configured,
        structuringConfigured=settings.structuring_configured,
        transcriptionModel=settings.deepgram_model,
        structuringModel=settings.gemini_model,
    )


@router.post(
    "/logbook/draft",
    response_model=LogbookDraftResponse,
    tags=["logbook"],
    summary="Audio de un parte de relevo a borrador estructurado",
)
async def logbook_draft(
    request: Request, file: UploadFile = File(...)
) -> LogbookDraftResponse:
    """
    Devuelve un BORRADOR. No guarda nada, y no es un registro.

    Si el estructurador no responde, la respuesta llega igual con la
    transcripcion y `estructuraOmitidaPor` explicando por que: el parte
    se puede registrar de todas formas.
    """
    audio, tipo = await _leer_audio(request, file)
    return await request.app.state.draft.draft(audio, tipo)


@router.post(
    "/transcribe",
    response_model=TranscriptionResponse,
    tags=["logbook"],
    summary="Solo transcribir, sin estructurar",
)
async def transcribe(
    request: Request, file: UploadFile = File(...)
) -> TranscriptionResponse:
    """
    Transcribe y ya.

    Existe separado porque no todo dictado es un parte de turno, y
    porque permite ver que dijo el proveedor sin el ruido de la
    estructuracion cuando algo no cuadra.
    """
    audio, tipo = await _leer_audio(request, file)
    transcripcion, ms = await request.app.state.draft.transcribe(audio, tipo)
    return TranscriptionResponse(transcripcion=transcripcion, processingTimeMs=ms)
