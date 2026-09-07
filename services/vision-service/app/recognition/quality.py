"""
Control de calidad de las capturas.

Descartar un rostro malo cuesta un frame; aceptarlo produce un embedding
ruidoso que puede provocar un falso positivo. Se filtra antes de embeber.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from app.detection.base import RawDetection


@dataclass(frozen=True)
class QualityReport:
    face_width_px: int
    face_height_px: int
    blur_score: float
    truncated: bool
    accepted: bool
    rejection_reason: str | None = None


# Tamaño al que se normaliza el recorte antes de medir la nitidez.
# Coincide con la entrada de ArcFace: lo que se mide es exactamente la
# nitidez que tendrá la imagen que genera el embedding.
_SHARPNESS_REFERENCE_SIZE = 112


def _sharpness(crop: np.ndarray) -> float:
    """
    Nitidez del recorte, independiente de su tamaño original.

    POR QUE SE NORMALIZA EL TAMAÑO
    ------------------------------
    La varianza del laplaciano depende de la escala: la misma cara
    medida a 300 px y a 100 px da valores muy distintos, porque al
    ampliar una imagen se interpolan píxeles y los bordes se suavizan.
    Un umbral absoluto sobre el recorte original rechazaría rostros
    lejanos perfectamente utilizables y aceptaría primeros planos
    movidos.

    Reescalando siempre a 112x112 antes de medir, el número resultante
    es comparable entre capturas y el umbral significa lo mismo para
    todas.
    """
    if crop.size == 0:
        return 0.0

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    normalized = cv2.resize(
        gray,
        (_SHARPNESS_REFERENCE_SIZE, _SHARPNESS_REFERENCE_SIZE),
        interpolation=cv2.INTER_AREA,
    )
    return float(cv2.Laplacian(normalized, cv2.CV_64F).var())


def assess(
    image_bgr: np.ndarray,
    detection: RawDetection,
    min_face_size_px: int,
    min_detection_score: float,
    min_blur_score: float = 12.0,
) -> QualityReport:
    h, w = image_bgr.shape[:2]
    fw, fh = int(detection.width), int(detection.height)

    # Un rostro pegado al borde suele estar cortado: el recorte alineado
    # saldría incompleto y el embedding sería poco fiable.
    margin = 2
    truncated = (
        detection.x1 <= margin
        or detection.y1 <= margin
        or detection.x2 >= w - margin
        or detection.y2 >= h - margin
    )

    x1 = max(0, int(detection.x1))
    y1 = max(0, int(detection.y1))
    x2 = min(w, int(detection.x2))
    y2 = min(h, int(detection.y2))
    crop = image_bgr[y1:y2, x1:x2]

    blur = _sharpness(crop)

    reason: str | None = None
    if detection.score < min_detection_score:
        reason = "detection_score_bajo"
    elif min(fw, fh) < min_face_size_px:
        reason = "rostro_demasiado_pequeno"
    elif blur < min_blur_score:
        reason = "imagen_borrosa"

    return QualityReport(
        face_width_px=fw,
        face_height_px=fh,
        blur_score=round(blur, 2),
        truncated=truncated,
        accepted=reason is None,
        rejection_reason=reason,
    )
