"""
Alineación facial previa a ArcFace.

POR QUE ESTE PASO ES CRITICO
----------------------------
ArcFace fue entrenado exclusivamente con recortes de 112x112 alineados
mediante 5 puntos faciales canónicos. Si se le pasa el recorte crudo de
una caja del detector (rotado o descentrado) el rostro cae fuera de la
distribución de entrenamiento y la precisión se degrada de forma notable.

rostros.pt tiene cabeza 'Detect': entrega cajas pero NO landmarks
(verificado con scripts/inspect_model.py). Por eso, cuando el detector no
los proporciona, se estiman con el modelo 2d106det de InsightFace.

MAPEO 106 -> 5 PUNTOS
---------------------
Los índices se derivaron EMPIRICAMENTE, no de documentación: se compararon
los 106 landmarks contra los 5 puntos nativos de SCRFD sobre las imágenes
de prueba de InsightFace, tomando el landmark más cercano a cada punto.

    Resultado de la validación (6 rostros):
      error medio de posición ............ 2.4 - 3.7 px
      similitud coseno del embedding
      resultante vs. alineación nativa ... 0.977 - 0.997

Es decir: alinear con estos puntos produce prácticamente el mismo
embedding que la alineación nativa de InsightFace.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from app.core.errors import ModelNotReadyError
from app.core.logging import get_logger

logger = get_logger(__name__)

# Indices validados empíricamente: ojo izq, ojo der, nariz, boca izq, boca der
LANDMARK_106_TO_5 = [33, 96, 86, 65, 61]

ARCFACE_INPUT_SIZE = 112


class FaceAligner:
    """Convierte (imagen, detección) en un recorte canónico de 112x112."""

    def __init__(self, model_pack: str = "buffalo_l"):
        self._pack = model_pack
        self._landmarker = None
        self._loaded = False

    @property
    def is_ready(self) -> bool:
        return self._loaded

    def load(self) -> None:
        if self._loaded:
            return
        from insightface import model_zoo
        from insightface.utils import storage

        model_dir = Path(storage.ensure_available("models", self._pack))
        landmark_path = model_dir / "2d106det.onnx"
        if not landmark_path.exists():
            raise ModelNotReadyError(f"Falta el modelo de landmarks: {landmark_path}")

        self._landmarker = model_zoo.get_model(
            str(landmark_path), providers=["CPUExecutionProvider"]
        )
        self._landmarker.prepare(ctx_id=-1)
        self._loaded = True
        logger.info("alineador_cargado", model="2d106det", pack=self._pack)

    def estimate_keypoints(
        self, image_bgr: np.ndarray, bbox: tuple[float, float, float, float]
    ) -> np.ndarray:
        """Estima los 5 puntos canónicos a partir de una caja sin landmarks."""
        if not self._loaded or self._landmarker is None:
            raise ModelNotReadyError("El alineador no está cargado")

        from insightface.app.common import Face

        face = Face(bbox=np.array(bbox, dtype=np.float32), det_score=1.0)
        self._landmarker.get(image_bgr, face)
        landmarks = face["landmark_2d_106"]
        return np.array([landmarks[i] for i in LANDMARK_106_TO_5], dtype=np.float32)

    def align(
        self,
        image_bgr: np.ndarray,
        bbox: tuple[float, float, float, float],
        keypoints: np.ndarray | None = None,
    ) -> np.ndarray:
        """
        Devuelve el recorte alineado de 112x112 listo para ArcFace.

        Si el detector ya entregó keypoints (caso SCRFD) se usan tal cual;
        si no (caso rostros.pt) se estiman con el modelo de landmarks.
        """
        from insightface.utils import face_align

        kps = (
            keypoints
            if keypoints is not None
            else self.estimate_keypoints(image_bgr, bbox)
        )
        return face_align.norm_crop(image_bgr, kps, ARCFACE_INPUT_SIZE)
