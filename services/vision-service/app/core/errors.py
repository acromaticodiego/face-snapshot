"""Errores de dominio del Vision Service, con formato uniforme."""

from fastapi import Request
from fastapi.responses import JSONResponse


class VisionError(Exception):
    status_code = 500
    code = "VISION_ERROR"

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class InvalidImageError(VisionError):
    status_code = 422
    code = "INVALID_IMAGE"


class ImageTooLargeError(VisionError):
    status_code = 413
    code = "IMAGE_TOO_LARGE"


class ModelNotReadyError(VisionError):
    status_code = 503
    code = "MODEL_NOT_READY"


async def vision_error_handler(request: Request, exc: VisionError) -> JSONResponse:
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
