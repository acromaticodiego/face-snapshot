"""Configuracion del Voice Service. Todo via variables de entorno."""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    service_name: str = "voice-service"
    environment: Literal["development", "production"] = "development"
    log_level: str = "INFO"
    port: int = Field(default=8001, alias="VOICE_SERVICE_PORT")

    # ── Transcripcion (Deepgram) ──────────────────────────────────
    deepgram_api_key: str = Field(default="", alias="DEEPGRAM_API_KEY")
    deepgram_url: str = Field(
        default="https://api.deepgram.com/v1/listen", alias="DEEPGRAM_URL"
    )
    # MEDIDO sobre 37.7 s de audio en espanol, no elegido de oido:
    # nova-3 tardo 1955 ms y nova-2 8308 ms para una transcripcion
    # identica. Cuatro veces mas rapido por el mismo resultado.
    deepgram_model: str = Field(default="nova-3", alias="DEEPGRAM_MODEL")
    deepgram_language: str = Field(default="es", alias="DEEPGRAM_LANGUAGE")

    # ── Estructuracion (Gemini) ───────────────────────────────────
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    gemini_url: str = Field(
        default="https://generativelanguage.googleapis.com/v1beta/models",
        alias="GEMINI_URL",
    )
    # Se fija una version CONCRETA y no un alias tipo
    # `gemini-flash-latest`: un alias cambia de modelo por debajo sin
    # que nadie toque nada, y con el cambiarian las incidencias que el
    # sistema estructura a partir del mismo parte. Un registro de
    # seguridad no puede cambiar de contenido porque un proveedor haya
    # promocionado otro modelo el martes.
    #
    # POR QUE ESTE Y NO EL MAS NUEVO, que esta medido sobre un parte
    # dictado de verdad. Los tres candidatos sacaron las MISMAS dos
    # incidencias, bien clasificadas y con las dos citas respaldadas:
    #
    #     gemini-3.6-flash ........ 13125 ms
    #     gemini-3.5-flash-lite .... 2067 ms
    #     gemini-3.1-flash-lite .... 2540 ms
    #
    # Seis veces mas rapido por el mismo resultado, delante de alguien
    # que espera al final de su turno.
    #
    # Y HAY UNA CUOTA QUE CONVIENE CONOCER: el plan gratuito da 20
    # peticiones al DIA por modelo
    # (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`). Se agota
    # probando, y cuando pasa el servicio lo dice con esas palabras en
    # lugar de "no respondio". Las cuotas son por modelo, asi que
    # cambiar `GEMINI_MODEL` da otras 20.
    gemini_model: str = Field(default="gemini-3.5-flash-lite", alias="GEMINI_MODEL")

    # ── Limites ───────────────────────────────────────────────────
    max_audio_size_mb: int = Field(default=25, alias="MAX_AUDIO_SIZE_MB")
    # Plazos separados porque las dos llamadas no se parecen: la
    # transcripcion crece con la duracion del audio y la
    # estructuracion no depende de ella.
    transcribe_timeout_s: float = Field(default=120.0, alias="TRANSCRIBE_TIMEOUT_S")
    structure_timeout_s: float = Field(default=45.0, alias="STRUCTURE_TIMEOUT_S")

    cors_origins: str = Field(default="http://localhost:5173", alias="CORS_ORIGINS")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def max_audio_bytes(self) -> int:
        return self.max_audio_size_mb * 1024 * 1024

    @property
    def transcription_configured(self) -> bool:
        return bool(self.deepgram_api_key)

    @property
    def structuring_configured(self) -> bool:
        return bool(self.gemini_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
