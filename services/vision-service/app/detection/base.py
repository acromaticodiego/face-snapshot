"""
Interfaz común de detectores faciales.

Existe para que el detector sea intercambiable: hoy usamos rostros.pt
(el modelo entrenado del proyecto) y mañana se puede cambiar a SCRFD
—o a un rostros.pt v2— sin tocar el resto del pipeline.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class RawDetection:
    """Detección en coordenadas de la imagen original."""

    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    # 5 puntos faciales (ojo izq, ojo der, nariz, boca izq, boca der).
    # rostros.pt tiene cabeza 'Detect' y NO los entrega → None.
    # En ese caso los estima el módulo de landmarks antes de alinear.
    keypoints: np.ndarray | None = None

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1


class FaceDetector(ABC):
    """Contrato que debe cumplir cualquier detector."""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def version(self) -> str: ...

    @property
    @abstractmethod
    def provides_keypoints(self) -> bool:
        """True si el detector ya entrega los 5 puntos de alineación."""

    @abstractmethod
    def load(self) -> None: ...

    @abstractmethod
    def detect(self, image_bgr: np.ndarray) -> list[RawDetection]: ...

    @property
    def is_ready(self) -> bool:
        return getattr(self, "_loaded", False)
