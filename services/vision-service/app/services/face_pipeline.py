"""
Pipeline de visión: imagen -> rostros con embedding.

    [1] DETECCION    rostros.pt (YOLOv8s)  -> cajas + confianza
    [2] CALIDAD      descarta capturas malas antes de gastar cómputo
    [3] LANDMARKS    2d106det -> 5 puntos canónicos
    [4] ALINEACION   transformación de similitud -> recorte 112x112
    [5] EMBEDDING    ArcFace w600k_r50 -> vector 512-d normalizado L2
    [6] VIDA         MiniFASNet sobre el frame ORIGINAL -> probabilidad

Este servicio NO tiene estado y NO conoce identidades: convierte píxeles
en vectores. Quien decide "de quién es este rostro" es el Face Service.
"""

from __future__ import annotations

import time

import numpy as np
from opentelemetry import trace

from app.core.config import Settings
from app.core.logging import get_logger
from app.core.telemetry import tracer
from app.detection.base import FaceDetector
from app.recognition import liveness, quality
from app.recognition.aligner import FaceAligner
from app.recognition.embedder import ArcFaceEmbedder
from app.recognition.spoof import SpoofDetector
from app.schemas.vision import (
    BoundingBox,
    DetectedFace,
    DetectedFaceLite,
    FaceQuality,
    Liveness,
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
        spoof_detector: SpoofDetector,
        settings: Settings,
    ):
        self._detector = detector
        self._aligner = aligner
        self._embedder = embedder
        self._spoof = spoof_detector
        self._settings = settings

    def load(self) -> None:
        """Carga los modelos. Se llama una sola vez al arrancar el servicio."""
        self._detector.load()
        self._aligner.load()
        self._embedder.load()
        self._spoof.load()

    @property
    def detector_ready(self) -> bool:
        return self._detector.is_ready

    @property
    def embedder_ready(self) -> bool:
        return self._embedder.is_ready

    @property
    def spoof_ready(self) -> bool:
        return self._spoof.is_ready

    @property
    def is_ready(self) -> bool:
        return (
            self._detector.is_ready
            and self._aligner.is_ready
            and self._embedder.is_ready
            and self._spoof.is_ready
        )

    @property
    def model_info(self) -> ModelInfo:
        return ModelInfo(
            detector=self._detector.name,
            detectorVersion=self._detector.version,
            embedder=self._embedder.name,
            embedderVersion=self._embedder.version,
            spoofDetector=self._spoof.name,
            spoofDetectorVersion=self._spoof.version,
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
        """
        Detección + alineación + embedding para cada rostro.

        CADA ETAPA ES UN SPAN, Y NO ES DECORACION
        ─────────────────────────────────────────
        Hasta la Fase 4 este método solo sabía decir cuánto tardaba
        entero. Eso no responde la pregunta que importa —si el coste
        está en el detector, en la alineación o en el embedding— y esa
        pregunta hace falta para saber cuánto margen hay para gastar en
        una captura mejor, que es lo que de verdad arreglaría el margen
        estrecho del umbral.
        """
        started = time.perf_counter()
        h, w = image_bgr.shape[:2]

        with tracer.start_as_current_span("vision.detect") as span:
            detections = self._detector.detect(image_bgr)[
                : self._settings.max_faces_per_frame
            ]
            span.set_attribute("vision.image.width", w)
            span.set_attribute("vision.image.height", h)
            span.set_attribute("vision.faces.detected", len(detections))

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

            caja = self._to_bbox(det, w, h)

            try:
                # La alineación incluye los landmarks: es el paso que el
                # ADR 0002 documenta como obligatorio, y conviene poder
                # ver lo que cuesta por separado del embedding.
                with tracer.start_as_current_span("vision.align"):
                    aligned = self._aligner.align(
                        image_bgr,
                        (det.x1, det.y1, det.x2, det.y2),
                        keypoints=det.keypoints if self._detector.provides_keypoints else None,
                    )
                with tracer.start_as_current_span("vision.embed") as span:
                    embedding = self._embedder.embed(aligned)
                    span.set_attribute("vision.embedding.dim", len(embedding))
                # Se mide sobre el recorte YA alineado, que es el mismo
                # que ve ArcFace: asi el numero significa lo mismo para
                # una cara cercana y para una lejana.
                with tracer.start_as_current_span("vision.liveness") as span:
                    vida = liveness.assess(aligned)
                    span.set_attribute("vision.liveness.detail_ratio", vida.detail_ratio)
                    span.set_attribute("vision.liveness.pattern_peak", vida.pattern_peak)
                # Sobre el frame ORIGINAL y con la caja del detector, no
                # sobre el recorte alineado: entre el sensor y los 112x112
                # hay dos reducciones sin antialias, y eso es justo lo que
                # borro la senal anterior (ADR 0010, actualizacion).
                #
                # Span propio porque es el gasto nuevo de esta fase y hay
                # que poder verlo por separado: son ~23 ms frente a los
                # ~740 del detector, y esa proporcion es la que justifica
                # tenerlo encendido en cada frame.
                with tracer.start_as_current_span("vision.spoof") as span:
                    suplantacion = self._spoof.score(
                        image_bgr, (caja.x, caja.y, caja.width, caja.height)
                    )
                    span.set_attribute("vision.spoof.measured", suplantacion is not None)
                    if suplantacion is not None:
                        span.set_attribute(
                            "vision.spoof.real_score", suplantacion.real_score
                        )
                        span.set_attribute("vision.spoof.label", suplantacion.label_name)
            except Exception as exc:  # noqa: BLE001
                # Un rostro que falla no debe tumbar el frame completo.
                logger.warning("fallo_al_embeber_rostro", error=str(exc))
                rejected += 1
                continue

            faces.append(
                DetectedFace(
                    bbox=caja,
                    detectionScore=round(det.score, 4),
                    embedding=embedding.tolist(),
                    quality=FaceQuality(
                        faceWidthPx=report.face_width_px,
                        faceHeightPx=report.face_height_px,
                        blurScore=report.blur_score,
                        truncated=report.truncated,
                    ),
                    liveness=Liveness(
                        # None si no se pudo medir, nunca 0.0: ver el
                        # esquema. Un cero es «ataque segurisimo».
                        spoofScore=(
                            suplantacion.real_score if suplantacion else None
                        ),
                        detailRatio=vida.detail_ratio,
                        patternPeak=vida.pattern_peak,
                    ),
                )
            )

        elapsed = round((time.perf_counter() - started) * 1000, 2)

        # Resumen en el span de la petición. NUNCA el embedding ni nada
        # derivado de la imagen: una traza es un registro más, y la
        # política de privacidad del sistema no cambia porque el destino
        # se llame Tempo.
        span_actual = trace.get_current_span()
        span_actual.set_attribute("vision.faces.accepted", len(faces))
        span_actual.set_attribute("vision.faces.rejected", rejected)

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
