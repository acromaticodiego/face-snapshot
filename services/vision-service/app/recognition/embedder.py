"""
Generación de embeddings faciales con ArcFace (InsightFace w600k_r50).

POR QUE ARCFACE Y NO FACENET
----------------------------
ArcFace usa una pérdida de margen angular aditivo que produce un espacio
de embeddings con separación mucho más clara entre identidades. Medido
sobre las imágenes de prueba de InsightFace:

    misma persona ......... ~0.99 de similitud coseno
    personas distintas .... -0.08 a 0.21

Ese hueco es lo que permite fijar un umbral fiable. Además corre sobre
onnxruntime, sin necesidad de PyTorch en tiempo de inferencia.

El vector resultante tiene 512 dimensiones y se normaliza L2, de modo que
el producto escalar entre dos vectores ES su similitud coseno.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from app.core.errors import ModelNotReadyError
from app.core.logging import get_logger

logger = get_logger(__name__)


class ArcFaceEmbedder:
    def __init__(
        self, model_pack: str = "buffalo_l", model_file: str = "w600k_r50.onnx"
    ):
        self._pack = model_pack
        self._model_file = model_file
        self._model = None
        self._loaded = False
        self._dim = 512

    @property
    def is_ready(self) -> bool:
        return self._loaded

    @property
    def name(self) -> str:
        return f"{self._pack}/{Path(self._model_file).stem}"

    @property
    def version(self) -> str:
        # Cambiar este valor OBLIGA a re-enrolar: los embeddings de modelos
        # distintos viven en espacios vectoriales incompatibles y no se
        # pueden comparar entre sí.
        return "1"

    @property
    def dim(self) -> int:
        return self._dim

    def load(self) -> None:
        if self._loaded:
            return
        from insightface import model_zoo
        from insightface.utils import storage

        model_dir = Path(storage.ensure_available("models", self._pack))
        model_path = model_dir / self._model_file
        if not model_path.exists():
            raise ModelNotReadyError(f"Falta el modelo de embeddings: {model_path}")

        self._model = model_zoo.get_model(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        self._model.prepare(ctx_id=-1)
        self._loaded = True
        logger.info("embedder_cargado", model=self.name, dim=self._dim)

    def embed(self, aligned_face_112: np.ndarray) -> np.ndarray:
        """
        Recibe un recorte alineado de 112x112 y devuelve un vector 512-d
        normalizado L2.
        """
        if not self._loaded or self._model is None:
            raise ModelNotReadyError("El modelo de embeddings no está cargado")

        vector = self._model.get_feat(aligned_face_112).flatten().astype(np.float32)
        norm = float(np.linalg.norm(vector))
        if norm < 1e-8:
            raise ModelNotReadyError("Embedding degenerado (norma nula)")
        return vector / norm
