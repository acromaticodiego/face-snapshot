"""
Pipeline de visión: imagen -> rostros con embedding.

    [1] DETECCION    rostros.pt (YOLOv8s)  -> cajas + confianza
    [2] CALIDAD      descarta capturas malas antes de gastar cómputo
    [3] LANDMARKS    2d106det -> 5 puntos canónicos
    [4] ALINEACION   transformación de similitud -> recorte 112x112
    [5] EMBEDDING    ArcFace w600k_r50 -> vector 512-d normalizado L2

Este servicio NO tiene estado y NO conoce identidades: convierte píxeles
en vectores. Quien decide "de quién es este rostro" es el Face Service.
"""

from __future__ import annotations

import time

import numpy as np

from app.core.config import Settings
from app.core.logging import get_logger
from app.detection.base import FaceDetector
from app.recognition import quality
from app.recognition.aligner import FaceAligner
from app.recognition.embedder import ArcFaceEmbedder
from app.schemas.vision import (
    BoundingBox,
    DetectedFace,
    DetectedFaceLite,
    FaceQuality,
    ModelInfo,
    VisionAnalyzeResponse,
    VisionDetectOnlyResponse,
)

logger = get_logger(__name__)


class FacePipeline:
    def __init__(
        self,
        detector: FaceDetector,
        aligner: FaceAligner,
        embedder: ArcFaceEmbedder,
        settings: Settings,
    ):
        self._detector = detector
        self._aligner = aligner
        self._embedder = embedder
        self._settings = settings

    def load(self) -> None:
        """Carga los modelos. Se llama una sola vez al arrancar el servicio."""
        self._detector.load()
        self._aligner.load()
        self._embedder.load()

    @property
    def detector_ready(self) -> bool:
        return self._detector.is_ready

    @property
    def embedder_ready(self) -> bool:
        return self._embedder.is_ready

    @property
    def is_ready(self) -> bool:
        return (
            self._detector.is_ready
            and self._aligner.is_ready
            and self._embedder.is_ready
        )

    @property
    def model_info(self) -> ModelInfo:
        return ModelInfo(
            detector=self._detector.name,
            detectorVersion=self._detector.version,
            embedder=self._embedder.name,
            embedderVersion=self._embedder.version,
        )

    @staticmethod
    def _to_bbox(det, image_w: int, image_h: int) -> BoundingBox:
        """Recorta la caja a los límites de la imagen y la pasa a enteros."""
        x = max(0, int(round(det.x1)))
        y = max(0, int(round(det.y1)))
        x2 = min(image_w, int(round(det.x2)))
        y2 = min(image_h, int(round(det.y2)))
        return BoundingBox(x=x, y=y, width=max(1, x2 - x), height=max(1, y2 - y))

    def detect_only(self, image_bgr: np.ndarray) -> VisionDetectOnlyResponse:
        """
        Solo detección, sin embeddings.

        Se usa para previsualizar cajas (por ejemplo en la pantalla de
        registro, para que el operador encuadre bien antes de capturar).
        Es más rápido y no toca datos biométricos.
        """
        started = time.perf_counter()
        h, w = image_bgr.shape[:2]
        detections = self._detector.detect(image_bgr)[
            : self._settings.max_faces_per_frame
        ]

        return VisionDetectOnlyResponse(
            faces=[
                DetectedFaceLite(
                    bbox=self._to_bbox(d, w, h),
                    detectionScore=round(d.score, 4),
                )
                for d in detections
            ],
            imageWidth=w,
            imageHeight=h,
            processingTimeMs=round((time.perf_counter() - started) * 1000, 2),
        )

    def analyze(self, image_bgr: np.ndarray) -> VisionAnalyzeResponse:
        """Detección + alineación + embedding para cada rostro."""
        started = time.perf_counter()
        h, w = image_bgr.shape[:2]

        detections = self._detector.detect(image_bgr)[
            : self._settings.max_faces_per_frame
        ]

        faces: list[DetectedFace] = []
        rejected = 0

        for det in detections:
            report = quality.assess(
                image_bgr,
                det,
                min_face_size_px=self._settings.min_face_size_px,
                min_detection_score=self._settings.min_detection_score,
                min_blur_score=self._settings.min_blur_score,
            )
            if not report.accepted:
                rejected += 1
                continue

            try:
                aligned = self._aligner.align(
                    image_bgr,
                    (det.x1, det.y1, det.x2, det.y2),
                    keypoints=det.keypoints if self._detector.provides_keypoints else None,
                )
                embedding = self._embedder.embed(aligned)
            except Exception as exc:  # noqa: BLE001
                # Un rostro que falla no debe tumbar el frame completo.
                logger.warning("fallo_al_embeber_rostro", error=str(exc))
                rejected += 1
                continue

            faces.append(
                DetectedFace(
                    bbox=self._to_bbox(det, w, h),
                    detectionScore=round(det.score, 4),
                    embedding=embedding.tolist(),
                    quality=FaceQuality(
                        faceWidthPx=report.face_width_px,
                        faceHeightPx=report.face_height_px,
                        blurScore=report.blur_score,
                        truncated=report.truncated,
                    ),
                )
            )

        elapsed = round((time.perf_counter() - started) * 1000, 2)

        # Solo metadatos: nunca se registran imágenes ni embeddings.
        logger.info(
            "frame_analizado",
            detectados=len(detections),
            aceptados=len(faces),
            descartados=rejected,
            ms=elapsed,
        )

        return VisionAnalyzeResponse(
            faces=faces,
            imageWidth=w,
            imageHeight=h,
            processingTimeMs=elapsed,
            modelInfo=self.model_info,
        )
