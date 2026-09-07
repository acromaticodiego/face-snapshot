"""Selección del detector según configuración."""

from app.core.config import Settings
from app.detection.base import FaceDetector
from app.detection.scrfd_detector import ScrfdFaceDetector
from app.detection.yolo_detector import YoloFaceDetector


def build_detector(settings: Settings) -> FaceDetector:
    if settings.detector_backend == "scrfd":
        return ScrfdFaceDetector(
            model_pack=settings.insightface_pack,
            min_score=settings.min_detection_score,
        )
    return YoloFaceDetector(
        model_path=settings.yolo_model_path,
        confidence=settings.yolo_confidence,
        iou=settings.yolo_iou,
        imgsz=settings.yolo_imgsz,
    )
