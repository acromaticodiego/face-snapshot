"""
Detector basado en rostros.pt — el modelo YOLOv8s entrenado del proyecto.

Verificado con scripts/inspect_model.py:
    task = detect · nc = 1 · names = {0: 'rostro'} · imgsz = 640
    cabeza 'Detect' → entrega cajas, NO landmarks.

El modelo se abre en solo lectura. Nunca se reentrena ni se sobrescribe.
"""

from __future__ import annotations

import threading
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

        # ── Por que hay un candado aqui y no en los otros modelos ────
        #
        # `ultralytics.YOLO.predict()` NO es seguro entre hilos: crea y
        # reutiliza un `predictor` colgado del propio objeto del modelo,
        # y le va escribiendo el lote y los resultados de cada llamada.
        # Dos hilos entrando a la vez se pisan ese estado, y el sintoma
        # no seria una excepcion: serian cajas de un frame apareciendo
        # en la respuesta de otro. En un control de acceso eso es
        # reconocer a la persona equivocada.
        #
        # El alineador y el embebedor NO lo necesitan: van sobre
        # onnxruntime, cuyo `session.run()` si es seguro entre hilos, y
        # sus envoltorios de insightface no guardan estado entre
        # llamadas.
        #
        # El candado serializa la deteccion DENTRO de un proceso, pero
        # eso cuesta menos de lo que parece: lo que se gana es que la
        # alineacion y el embedding de un frame -que son onnxruntime, y
        # sueltan el GIL- se solapen con la deteccion de otro. Medido,
        # ese solapamiento sube el rendimiento de 1.25 a 2.28 frames/s.
        #
        # Tener varios procesos evitaria el candado por completo, y por
        # eso existe `VISION_WORKERS`. Pero medido en esta maquina no
        # anade nada distinguible del ruido: una sola inferencia de
        # torch ya usa la mitad de los nucleos. El razonamiento
        # completo, con las cifras, esta en el Dockerfile.
        self._predict_lock = threading.Lock()

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

        with self._predict_lock:
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
