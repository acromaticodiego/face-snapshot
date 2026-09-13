"""Errores de dominio del Voice Service, con el formato del resto."""

from fastapi import Request
from fastapi.responses import JSONResponse


class VoiceError(Exception):
    status_code = 500
    code = "VOICE_ERROR"

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class InvalidAudioError(VoiceError):
    status_code = 422
    code = "INVALID_AUDIO"


class AudioTooLargeError(VoiceError):
    status_code = 413
    code = "AUDIO_TOO_LARGE"


class TranscriptionUnavailableError(VoiceError):
    """
    No se pudo transcribir: sin clave, sin red, o Deepgram devolvio error.

    Es 503 y no 500 a proposito, y el codigo viaja al cliente porque hay
    una salida: escribir el parte a mano. Un vigilante que acaba su
    turno no puede quedarse sin dejar constancia porque un proveedor
    externo este caido.
    """

    status_code = 503
    code = "TRANSCRIPTION_UNAVAILABLE"


async def voice_error_handler(request: Request, exc: VoiceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "statusCode": exc.status_code,
            "error": exc.__class__.__name__,
            "message": exc.message,
            "code": exc.code,
            "path": str(request.url.path),
        },
    )
