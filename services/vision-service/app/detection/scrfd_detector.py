"""
Detector SCRFD de InsightFace. Alternativa a rostros.pt.

Ventaja: entrega los 5 puntos faciales en la misma pasada, así que no
hace falta un modelo de landmarks aparte. Se activa con
FACE_DETECTOR_BACKEND=scrfd.
"""

from __future__ import annotations

import numpy as np

from app.core.errors import ModelNotReadyError
from app.core.logging import get_logger
from app.detection.base import FaceDetector, RawDetection

logger = get_logger(__name__)


class ScrfdFaceDetector(FaceDetector):
    def __init__(self, model_pack: str = "buffalo_l", min_score: float = 0.5):
        self._pack = model_pack
        self._min_score = min_score
        self._app = None
        self._loaded = False

    @property
    def name(self) -> str:
        return f"InsightFace SCRFD ({self._pack})"

    @property
    def version(self) -> str:
        return f"scrfd-{self._pack}"

    @property
    def provides_keypoints(self) -> bool:
        return True

    def load(self) -> None:
        if self._loaded:
            return
        from insightface.app import FaceAnalysis

        self._app = FaceAnalysis(
            name=self._pack,
            allowed_modules=["detection"],
            providers=["CPUExecutionProvider"],
        )
        self._app.prepare(ctx_id=-1, det_size=(640, 640))
        self._loaded = True
        logger.info("detector_cargado", backend="scrfd", pack=self._pack)

    def detect(self, image_bgr: np.ndarray) -> list[RawDetection]:
        if not self._loaded or self._app is None:
            raise ModelNotReadyError("El detector SCRFD no está cargado")

        faces = self._app.get(image_bgr)
        detections = [
            RawDetection(
                x1=float(f.bbox[0]), y1=float(f.bbox[1]),
                x2=float(f.bbox[2]), y2=float(f.bbox[3]),
                score=float(f.det_score),
                keypoints=np.asarray(f.kps, dtype=np.float32) if f.kps is not None else None,
            )
            for f in faces
            if float(f.det_score) >= self._min_score
        ]
        detections.sort(key=lambda d: d.width * d.height, reverse=True)
        return detections
