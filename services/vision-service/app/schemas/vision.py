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


class DetectedFace(BaseModel):
    bbox: BoundingBox
    detectionScore: float = Field(ge=0, le=1)
    embedding: list[float]
    quality: FaceQuality


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
