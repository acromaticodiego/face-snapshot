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

    Son medidas crudas sobre el rostro; quien decide que significan es
    el Access Service, porque un umbral de seguridad es politica y este
    servicio no tiene politica.

    LA QUE DECIDE ES `spoofScore`. Las otras dos se miden todavia, pero
    quedaron refutadas contra un ataque real (ADR 0014) y ya no las mira
    nadie: siguen aqui para poder comparar en la traza mientras dure el
    despliegue, y se retiraran cuando el modelo lleve tiempo corriendo.
    """

    #: Probabilidad de que el rostro sea una persona delante de la
    #: camara, segun MiniFASNet, en [0, 1]. Mas alto = mas real.
    #:
    #: AUSENTE SI NO SE PUDO MEDIR, y nunca 0.0: un cero significa
    #: «ataque segurisimo» y en modo HARD dejaria en la calle a una
    #: persona real por un fallo de codigo. La ausencia viaja como
    #: ausencia, y el Access Service no sospecha sin evidencia.
    spoofScore: float | None = None

    #: Energia en frecuencias altas frente al total util. REFUTADA: no
    #: distingue una cara real de una foto en una pantalla.
    detailRatio: float

    #: Fuerza del pico periodico mas marcado en la banda alta. REFUTADA,
    #: y ademas al reves de lo previsto: marca MAS ALTO con la cara real
    #: y correlaciona +0.39 con el ancho de la cara, asi que mide sobre
    #: todo a que distancia esta la persona de la camara.
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
    #: Quien produjo `spoofScore`. Va en la respuesta porque el umbral
    #: del Access Service esta calibrado contra ESTE modelo: si un dia
    #: cambia, la escala del numero cambia con el y el umbral deja de
    #: significar lo que significaba.
    spoofDetector: str
    spoofDetectorVersion: str


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
    spoofReady: bool
    detectorBackend: str
    embeddingModel: str
    embeddingDim: int
