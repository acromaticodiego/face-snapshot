"""
Detector basado en rostros.pt — el modelo YOLOv8s entrenado del proyecto.

Verificado con scripts/inspect_model.py:
    task = detect · nc = 1 · names = {0: 'rostro'} · imgsz = 640
    cabeza 'Detect' → entrega cajas, NO landmarks.

El modelo se abre en solo lectura. Nunca se reentrena ni se sobrescribe.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from app.core.errors import ModelNotReadyError
from app.core.logging import get_logger
from app.detection.base import FaceDetector, RawDetection

logger = get_logger(__name__)


class YoloFaceDetector(FaceDetector):
    def __init__(
        self,
        model_path: Path,
        confidence: float = 0.45,
        iou: float = 0.45,
        imgsz: int = 640,
    ):
        self._model_path = Path(model_path)
        self._confidence = confidence
        self._iou = iou
        self._imgsz = imgsz
        self._model = None
        self._loaded = False
        self._class_names: dict[int, str] = {}

    @property
    def name(self) -> str:
        return "rostros.pt (YOLOv8s)"

    @property
    def version(self) -> str:
        return f"yolov8s-rostros-1cls-imgsz{self._imgsz}"

    @property
    def provides_keypoints(self) -> bool:
        # Cabeza 'Detect': sin puntos faciales. El alineador los estima.
        return False

    def load(self) -> None:
        if self._loaded:
            return
        if not self._model_path.exists():
            raise ModelNotReadyError(f"No se encuentra el modelo: {self._model_path}")

        from ultralytics import YOLO

        self._model = YOLO(str(self._model_path))
        self._class_names = dict(self._model.names or {})

        # Salvaguarda: si alguien sustituye rostros.pt por otro modelo,
        # queremos enterarnos en el arranque y no en producción.
        values = {str(v).lower() for v in self._class_names.values()}
        if not values & {"rostro", "face", "cara"}:
            logger.warning(
                "modelo_sin_clase_facial",
                classes=self._class_names,
                aviso="El modelo cargado no parece detectar rostros.",
            )

        self._loaded = True
        logger.info(
            "detector_cargado",
            model=str(self._model_path.name),
            classes=self._class_names,
            imgsz=self._imgsz,
        )

    def detect(self, image_bgr: np.ndarray) -> list[RawDetection]:
        if not self._loaded or self._model is None:
            raise ModelNotReadyError("El detector no está cargado")

        results = self._model.predict(
            source=image_bgr,
            conf=self._confidence,
            iou=self._iou,
            imgsz=self._imgsz,
            verbose=False,
        )
        if not results:
            return []

        boxes = results[0].boxes
        if boxes is None or len(boxes) == 0:
            return []

        detections: list[RawDetection] = []
        for box in boxes:
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            detections.append(
                RawDetection(
                    x1=x1, y1=y1, x2=x2, y2=y2,
                    score=float(box.conf[0]),
                    keypoints=None,
                )
            )

        # Mayor primero: en control de acceso, el rostro más cercano manda.
        detections.sort(key=lambda d: d.width * d.height, reverse=True)
        return detections
