"""
Transcripcion con Deepgram.

POR QUE ESTE MODULO EXISTE SEPARADO
───────────────────────────────────
Mismo criterio que el ADR 0005 aplica a las llamadas entre servicios:
toda la conversacion con un proveedor externo vive en UN archivo. Si
manana se cambia Deepgram por otra cosa, se reescribe esto y nada mas.

POR QUE `punctuate` SI Y `smart_format` NO
──────────────────────────────────────────
Medido con 37.7 s de audio en espanol, el mismo parte con las dos
configuraciones:

    punctuate=true                 "hasta las tres y cuarto"
                                   "a las cinco menos veinte"
                                   "la camara del pasillo dos"

    punctuate + smart_format       "hasta las 3 y 4o"
                                   "a las 5 menos 20"
                                   "la camara del pasillo 2"

`smart_format` convierte "cuarto" en un ordinal y destroza la hora. En
un parte de relevo de turno eso no es un detalle de estilo: la hora a
la que salto una alarma es el dato por el que alguien va a volver a
leer ese parte. Se prefiere un numero escrito con letra y correcto a
uno en cifras y falso.

Y LA ELECCION DEL MODELO TAMBIEN ESTA MEDIDA
────────────────────────────────────────────
Sobre ese mismo audio, transcripcion identica palabra por palabra:

    nova-3 ....... 1955 ms
    nova-2 ....... 8308 ms

Cuatro veces mas rapido por el mismo resultado.
"""

from __future__ import annotations

import httpx

from app.core.config import Settings
from app.core.errors import TranscriptionUnavailableError
from app.core.logging import get_logger
from app.providers.reintentos import con_reintento
from app.schemas.voice import Transcripcion

logger = get_logger(__name__)


class DeepgramTranscriber:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def configured(self) -> bool:
        return self._settings.transcription_configured

    async def transcribe(self, audio: bytes, content_type: str) -> Transcripcion:
        """
        Convierte audio en texto.

        Lanza `TranscriptionUnavailableError` ante cualquier problema, y
        siempre con el mismo tipo: quien llama no puede hacer nada
        distinto segun si fallo la red o la clave, y lo unico que
        necesita saber es que toca escribir el parte a mano.
        """
        if not self.configured:
            raise TranscriptionUnavailableError(
                "La transcripcion no esta configurada en este despliegue"
            )

        params = {
            "model": self._settings.deepgram_model,
            "language": self._settings.deepgram_language,
            "punctuate": "true",
            # smart_format NO. Ver la cabecera del modulo: destroza las
            # horas dichas de viva voz, que es el dato que mas importa
            # en un parte de turno.
            "smart_format": "false",
        }

        try:
            async with httpx.AsyncClient(
                timeout=self._settings.transcribe_timeout_s
            ) as cliente:

                async def pedir() -> httpx.Response:
                    return await cliente.post(
                        self._settings.deepgram_url,
                        params=params,
                        content=audio,
                        headers={
                            "Authorization": f"Token {self._settings.deepgram_api_key}",
                            "Content-Type": content_type,
                        },
                    )

                respuesta = await con_reintento(
                    pedir,
                    al_reintentar=lambda motivo: logger.info(
                        "deepgram_reintento", motivo=motivo
                    ),
                )
        except httpx.HTTPError as exc:
            # El mensaje del proveedor NO se propaga tal cual: puede
            # llevar detalles del despliegue. Al log va el tipo, no el
            # contenido, y desde luego no el audio.
            logger.warning("deepgram_inalcanzable", error=type(exc).__name__)
            raise TranscriptionUnavailableError(
                "No se pudo contactar con el servicio de transcripcion"
            ) from exc

        if respuesta.status_code != 200:
            logger.warning("deepgram_error", estado=respuesta.status_code)
            raise TranscriptionUnavailableError(
                f"El servicio de transcripcion respondio {respuesta.status_code}"
            )

        return self._leer(respuesta.json())

    def _leer(self, cuerpo: dict) -> Transcripcion:
        """
        Extrae la transcripcion de la respuesta.

        Se valida la forma en lugar de confiar en ella: esto viene de
        otro proceso al otro lado de la red, exactamente el mismo
        argumento por el que el Shift Service valida con zod lo que le
        llega por el bus (ADR 0008). Un campo que cambie de sitio tiene
        que dar un error claro, no un texto vacio que acabe guardado
        como si fuera el parte de alguien.
        """
        try:
            canal = cuerpo["results"]["channels"][0]["alternatives"][0]
            texto = canal["transcript"]
            confianza = float(canal.get("confidence", 0.0))
            duracion = float(cuerpo.get("metadata", {}).get("duration", 0.0))
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            logger.warning("deepgram_respuesta_inesperada", error=type(exc).__name__)
            raise TranscriptionUnavailableError(
                "El servicio de transcripcion devolvio una respuesta inesperada"
            ) from exc

        if not texto.strip():
            raise TranscriptionUnavailableError(
                "No se reconocio ninguna palabra en el audio"
            )

        return Transcripcion(
            texto=texto,
            # Deepgram puede devolver confianzas ligeramente fuera de
            # rango; el esquema exige [0, 1] y un borrador no se pierde
            # por un decimal.
            confianza=min(1.0, max(0.0, confianza)),
            duracionSegundos=duracion,
            modelo=self._settings.deepgram_model,
        )
