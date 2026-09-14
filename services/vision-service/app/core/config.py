"""Configuración del Vision Service. Todo vía variables de entorno."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    service_name: str = "vision-service"
    environment: Literal["development", "production"] = "development"
    log_level: str = "INFO"
    port: int = Field(default=8000, alias="VISION_SERVICE_PORT")

    # ── Detector ──────────────────────────────────────────────────
    # 'yolo'  → rostros.pt, el modelo propio del proyecto (por defecto)
    # 'scrfd' → detector de InsightFace, alternativa de respaldo
    detector_backend: Literal["yolo", "scrfd"] = Field(
        default="yolo", alias="FACE_DETECTOR_BACKEND"
    )
    yolo_model_path: Path = Field(
        default=Path("../../modelos/rostros.pt"), alias="YOLO_FACE_MODEL_PATH"
    )
    yolo_confidence: float = Field(default=0.45, alias="YOLO_CONFIDENCE_THRESHOLD")
    yolo_iou: float = Field(default=0.45, alias="YOLO_IOU_THRESHOLD")
    yolo_imgsz: int = Field(default=640, alias="YOLO_IMAGE_SIZE")

    # ── Deteccion de vida ─────────────────────────────────────────
    # Los dos pesos de MiniFASNet van VERSIONADOS en el repositorio, no
    # se descargan al construir: deciden si una puerta se abre, y eso no
    # puede depender de que un tercero siga sirviendo un archivo ni
    # cambiar de contenido sin que nadie se entere (modelos/antispoof/
    # PROCEDENCIA.md). Aqui solo se dice donde estan montados.
    antispoof_models_dir: Path = Field(
        default=Path("../../modelos/antispoof"), alias="ANTISPOOF_MODELS_DIR"
    )

    # ── Embeddings ────────────────────────────────────────────────
    insightface_pack: str = Field(default="buffalo_l", alias="INSIGHTFACE_MODEL_PACK")
    embedding_model_name: str = Field(
        default="buffalo_l/w600k_r50", alias="EMBEDDING_MODEL_NAME"
    )
    embedding_model_version: str = Field(default="1", alias="EMBEDDING_MODEL_VERSION")
    embedding_dim: int = Field(default=512, alias="EMBEDDING_DIM")

    # ── Calidad y límites ─────────────────────────────────────────
    min_face_size_px: int = Field(default=80, alias="MIN_FACE_SIZE_PX")
    min_detection_score: float = Field(default=0.50, alias="MIN_DETECTION_SCORE")
    # Nitidez mínima, medida sobre el recorte normalizado a 112x112.
    # Calibrar con la cámara real: ver docs/adr/0003.
    min_blur_score: float = Field(default=12.0, alias="MIN_BLUR_SCORE")
    max_image_size_mb: int = Field(default=8, alias="MAX_IMAGE_SIZE_MB")
    max_faces_per_frame: int = 10

    cors_origins: str = Field(default="http://localhost:5173", alias="CORS_ORIGINS")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def max_image_bytes(self) -> int:
        return self.max_image_size_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
