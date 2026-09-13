"""Esquemas Pydantic del Vision Service.

Este modulo ES el contrato: el servicio que produce una respuesta es
el que define su forma (ver docs/adr/0008). El Face Service, que es
su unico consumidor, valida lo que recibe por su cuenta.
"""

from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class FaceQuality(BaseModel):
    faceWidthPx: int
    faceHeightPx: int
    blurScore: float
    truncated: bool


class Liveness(BaseModel):
    """
    Evidencia de vida. NO es un veredicto.

    Son medidas crudas sobre la textura del rostro; quien decide que
    significan es el Access Service, porque un umbral de seguridad es
    politica y este servicio no tiene politica.
    """

    #: Energia en frecuencias altas frente al total util. Cae con una
    #: reimpresion o una foto de una foto.
    detailRatio: float

    #: Fuerza del pico periodico mas marcado en la banda alta. Sube con
    #: la rejilla de una pantalla y con la recompresion JPEG.
    patternPeak: float


class DetectedFace(BaseModel):
    bbox: BoundingBox
    detectionScore: float = Field(ge=0, le=1)
    embedding: list[float]
    quality: FaceQuality
    liveness: Liveness


class ModelInfo(BaseModel):
    detector: str
    detectorVersion: str
    embedder: str
    embedderVersion: str


class VisionAnalyzeResponse(BaseModel):
    faces: list[DetectedFace]
    imageWidth: int
    imageHeight: int
    processingTimeMs: float
    modelInfo: ModelInfo


class DetectedFaceLite(BaseModel):
    bbox: BoundingBox
    detectionScore: float = Field(ge=0, le=1)


class VisionDetectOnlyResponse(BaseModel):
    faces: list[DetectedFaceLite]
    imageWidth: int
    imageHeight: int
    processingTimeMs: float


class HealthResponse(BaseModel):
    status: str
    service: str
    detectorReady: bool
    embedderReady: bool
    detectorBackend: str
    embeddingModel: str
    embeddingDim: int
