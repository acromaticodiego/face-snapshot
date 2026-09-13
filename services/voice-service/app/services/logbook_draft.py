"""
El camino completo: audio -> texto -> borrador estructurado.

EL AUDIO NO SE GUARDA EN NINGUN SITIO
─────────────────────────────────────
Entra como bytes en memoria, se manda a transcribir y se suelta. No se
escribe a disco, no se cachea, no aparece en ningun log. Es la misma
politica que el proyecto ya aplica a las imagenes faciales -se guarda
el vector, nunca la foto- y por el mismo motivo: lo que no se almacena
no se puede filtrar.

Queda el TEXTO, y eso es deliberado: el texto ES el parte. Lo que se
descarta es la voz, que es el dato biometrico.

LA DEGRADACION VA EN UNA SOLA DIRECCION
───────────────────────────────────────
Sin transcripcion no hay nada que hacer y se devuelve un 503 con un
codigo que el cliente entiende, para que ofrezca escribir el parte a
mano. Sin estructuracion SI hay algo que hacer: se devuelve la
transcripcion sola.

El orden de preferencia es siempre el mismo: que quede constancia del
turno. Un vigilante que termina su jornada no puede irse sin registrar
lo que paso porque un proveedor externo este caido.

POR QUE ESTO ES `async` Y EL PIPELINE DE VISION NO
──────────────────────────────────────────────────
El Vision Service saca su trabajo a un hilo aparte porque es CPU
bloqueante: 750 ms de inferencia congelarian el bucle de eventos. Aqui
es al reves, casi todo el tiempo es ESPERA a dos terceros. Ese trabajo
se queda en el bucle a proposito: mientras una peticion espera a
Deepgram, el proceso atiende las demas.
"""

from __future__ import annotations

import time

from app.core.config import Settings
from app.core.logging import get_logger
from app.core.telemetry import tracer
from app.providers.deepgram import DeepgramTranscriber
from app.providers.gemini import GeminiStructurer
from app.schemas.voice import Estructura, LogbookDraftResponse, Transcripcion
from app.services.citas import verificar_incidencias

logger = get_logger(__name__)


class LogbookDraftService:
    def __init__(
        self,
        transcriber: DeepgramTranscriber,
        structurer: GeminiStructurer,
        settings: Settings,
    ) -> None:
        self._transcriber = transcriber
        self._structurer = structurer
        self._settings = settings

    async def transcribe(self, audio: bytes, content_type: str) -> tuple[Transcripcion, float]:
        empezo = time.perf_counter()
        with tracer.start_as_current_span("voice.transcribe") as span:
            span.set_attribute("voice.audio.bytes", len(audio))
            span.set_attribute("voice.transcribe.model", self._settings.deepgram_model)
            transcripcion = await self._transcriber.transcribe(audio, content_type)
            # Al span van METRICAS, nunca el texto. Una traza se mira en
            # Grafana desde cualquier navegador con acceso, y el parte de
            # un turno no tiene por que estar ahi.
            span.set_attribute("voice.audio.seconds", transcripcion.duracionSegundos)
            span.set_attribute("voice.transcribe.confidence", transcripcion.confianza)
            span.set_attribute("voice.transcript.chars", len(transcripcion.texto))

        return transcripcion, round((time.perf_counter() - empezo) * 1000, 2)

    async def draft(self, audio: bytes, content_type: str) -> LogbookDraftResponse:
        empezo = time.perf_counter()

        transcripcion, ms_transcribir = await self.transcribe(audio, content_type)

        estructura: Estructura | None = None
        omitida: str | None = None
        ms_estructurar: float | None = None

        if not self._structurer.configured:
            omitida = "La estructuracion no esta configurada en este despliegue"
        else:
            arranque = time.perf_counter()
            with tracer.start_as_current_span("voice.structure") as span:
                span.set_attribute("voice.structure.model", self._settings.gemini_model)
                propuesta = await self._structurer.structure(transcripcion.texto)

                if propuesta is None:
                    omitida = "El estructurador no respondio; queda la transcripcion"
                    span.set_attribute("voice.structure.ok", False)
                else:
                    incidencias, sin_respaldo = verificar_incidencias(
                        propuesta.get("incidencias", []), transcripcion.texto
                    )
                    span.set_attribute("voice.structure.ok", True)
                    span.set_attribute("voice.incidents", len(incidencias))
                    # El numero que de verdad hay que vigilar: cuantas
                    # incidencias propuso el modelo sin poder senalar
                    # donde lo leyo.
                    span.set_attribute("voice.incidents.unbacked", sin_respaldo)

                    estructura = Estructura.model_validate(
                        {
                            "resumen": propuesta.get("resumen", ""),
                            "incidencias": incidencias,
                        }
                    )

                    if sin_respaldo:
                        logger.warning(
                            "incidencias_sin_respaldo",
                            total=len(incidencias),
                            sin_respaldo=sin_respaldo,
                        )

            ms_estructurar = round((time.perf_counter() - arranque) * 1000, 2)

        return LogbookDraftResponse(
            transcripcion=transcripcion,
            estructura=estructura,
            estructuraOmitidaPor=omitida,
            processingTimeMs=round((time.perf_counter() - empezo) * 1000, 2),
            transcribeTimeMs=ms_transcribir,
            structureTimeMs=ms_estructurar,
        )
