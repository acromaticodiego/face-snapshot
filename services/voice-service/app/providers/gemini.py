"""
Estructuracion con Gemini.

QUE HACE, Y SOBRE TODO QUE NO
─────────────────────────────
Recibe la transcripcion de un parte de relevo y devuelve una PROPUESTA
de incidencias. No decide nada, no consulta nada del dominio, no sabe
quien hablo ni en que sede. Es un ordenador de texto.

Todo lo que devuelve lo revisa una persona antes de que se guarde. Esa
no es una precaucion generica sobre los modelos de lenguaje: es que un
parte de relevo es un documento que se lee cuando algo ha salido mal, y
un renglon inventado en ese documento manda a alguien a investigar un
hecho que no ocurrio.

LA DEFENSA CONTRA LA INVENCION ES UNA COMPROBACION, NO UNA INSTRUCCION
──────────────────────────────────────────────────────────────────────
Al modelo se le exige una cita literal por incidencia, y despues ESTE
SERVICIO comprueba que esa cita esta de verdad en la transcripcion
(`app/services/citas.py`). Pedirle a un modelo que no invente es una
instruccion y no se puede verificar; exigirle que senale donde lo leyo
si se puede.

TEMPERATURA CERO Y VERSION FIJA
───────────────────────────────
Dos partes iguales tienen que dar el mismo borrador. Con temperatura
por encima de cero, el mismo audio produciria incidencias distintas
segun el dia, y nadie podria reproducir como se llego a un registro.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import httpx

from app.core.config import Settings
from app.core.logging import get_logger
from app.providers.reintentos import ESTADO_LIMITE_DE_TASA, con_reintento

logger = get_logger(__name__)

# El esquema que el modelo TIENE que rellenar. Se envia como
# `responseSchema`, asi que la respuesta llega ya en esta forma y no
# hay que arrancar JSON de un texto en prosa.
ESQUEMA_RESPUESTA = {
    "type": "object",
    "properties": {
        "resumen": {"type": "string"},
        "incidencias": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "titulo": {"type": "string"},
                    "categoria": {
                        "type": "string",
                        "enum": [
                            "ACCESO",
                            "ALARMA",
                            "MANTENIMIENTO",
                            "SEGURIDAD",
                            "OTRO",
                        ],
                    },
                    "gravedad": {
                        "type": "string",
                        "enum": ["BAJA", "MEDIA", "ALTA"],
                    },
                    "horaMencionada": {"type": "string"},
                    "requiereSeguimiento": {"type": "boolean"},
                    "citaLiteral": {"type": "string"},
                },
                "required": [
                    "titulo",
                    "categoria",
                    "gravedad",
                    "requiereSeguimiento",
                    "citaLiteral",
                ],
            },
        },
    },
    "required": ["resumen", "incidencias"],
}

INSTRUCCION = """\
Estructuras partes de relevo de turno de vigilancia, dictados en voz \
alta y transcritos automaticamente.

Reglas, en orden de importancia:

1. NO INVENTES NADA. Si algo no se dijo, no existe. No deduzcas causas, \
no completes horas, no supongas consecuencias.
2. Cada incidencia lleva `citaLiteral`: un fragmento COPIADO PALABRA POR \
PALABRA de la transcripcion que la respalda. Copialo exacto, sin \
corregir la gramatica ni la puntuacion, y que sea suficiente para \
entender de que se habla.
3. `horaMencionada` va tal y como se dijo ("las tres y cuarto"). No la \
conviertas a cifras ni la normalices.
4. Un turno sin novedades es una lista de incidencias VACIA, y esta bien \
que lo sea. No fuerces incidencias para llenarla.
5. `requiereSeguimiento` es verdadero solo si el parte dice o implica \
claramente que queda algo pendiente para el siguiente turno.
6. El `resumen` describe el turno en dos o tres frases, sin anadir nada \
que no este en el texto.

La transcripcion puede tener errores de reconocimiento. No los \
"arregles" cambiando lo que dice: si algo no se entiende, dejalo fuera.\
"""


@dataclass(frozen=True)
class ResultadoEstructura:
    """
    Lo que salio de intentar estructurar, con el MOTIVO cuando no salio.

    Antes esto era un `dict | None` y el motivo se perdia por el camino:
    la pantalla acababa diciendo "el estructurador no respondio" tanto si
    el servicio estaba caido como si la cuota del dia se habia agotado,
    que llevan a hacer cosas distintas -esperar, o cambiar de modelo-.

    Es la misma leccion que ya dejo el 503 de la transcripcion: el codigo
    dice QUE hacer y el motivo dice POR QUE, y hacen falta los dos.
    """

    datos: dict | None
    motivo: str | None = None

    @property
    def ok(self) -> bool:
        return self.datos is not None


#: Lo que se le cuenta a quien dicto, por cada forma de fallar.
MOTIVO_SIN_RESPUESTA = "El estructurador no respondio; queda la transcripcion"
MOTIVO_CUOTA = (
    "Se agoto la cuota diaria del modelo; queda la transcripcion"
)
MOTIVO_SIN_CONFIGURAR = "La estructuracion no esta configurada en este despliegue"


class GeminiStructurer:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def configured(self) -> bool:
        return self._settings.structuring_configured

    async def structure(self, transcripcion: str) -> ResultadoEstructura:
        """
        Propone la estructura de un parte.

        NO lanza ante un fallo: quedarse sin estructura es degradarse,
        no romperse. La transcripcion por si sola ya deja constancia del
        turno, que es lo que de verdad no se puede perder. Lo que si
        hace es decir POR QUE no la hay.
        """
        if not self.configured:
            return ResultadoEstructura(None, MOTIVO_SIN_CONFIGURAR)

        cuerpo = {
            "systemInstruction": {"parts": [{"text": INSTRUCCION}]},
            "contents": [
                {
                    "parts": [
                        {
                            "text": (
                                "Estructura este parte de relevo de turno:\n\n"
                                + transcripcion
                            )
                        }
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": ESQUEMA_RESPUESTA,
                "temperature": 0,
            },
        }

        url = (
            f"{self._settings.gemini_url.rstrip('/')}/"
            f"{self._settings.gemini_model}:generateContent"
        )

        try:
            async with httpx.AsyncClient(
                timeout=self._settings.structure_timeout_s
            ) as cliente:

                async def pedir() -> httpx.Response:
                    return await cliente.post(
                        url,
                        json=cuerpo,
                        # La clave va en cabecera y no en la query: una
                        # URL acaba en los logs de cualquier
                        # intermediario, y una cabecera de autorizacion
                        # no.
                        headers={"x-goog-api-key": self._settings.gemini_api_key},
                    )

                # CUATRO intentos, y el numero sale de verlo fallar.
                #
                # Este modelo devuelve `503 UNAVAILABLE` -"experiencing
                # high demand"- por RACHAS: sondeandolo seis veces
                # seguidas dio 2/6 en un momento y 6/6 pocos minutos
                # despues. Con tres intentos y esperas de 0.5 y 1.5
                # segundos solo se cubren DOS segundos de racha, y se
                # vio una racha sobrevivirlos.
                #
                # Con cuatro, las esperas suman unos siete segundos. Es
                # mucho para una pantalla, pero quien dicta ya ha
                # esperado a que se transcriba, y la alternativa no es
                # ir mas rapido: es quedarse sin estructuracion y tener
                # que escribir las incidencias a mano.
                respuesta = await con_reintento(
                    pedir,
                    intentos=4,
                    al_reintentar=lambda motivo: logger.info(
                        "gemini_reintento", motivo=motivo
                    ),
                )
        except httpx.HTTPError as exc:
            logger.warning("gemini_inalcanzable", error=type(exc).__name__)
            return ResultadoEstructura(None, MOTIVO_SIN_RESPUESTA)

        if respuesta.status_code == ESTADO_LIMITE_DE_TASA:
            # El plan gratuito da 20 peticiones al dia POR MODELO. Es un
            # limite que se alcanza probando, y decir "no respondio"
            # mandaria a revisar la red cuando lo que hay que hacer es
            # esperar a manana o cambiar GEMINI_MODEL.
            logger.warning("gemini_cuota_agotada", modelo=self._settings.gemini_model)
            return ResultadoEstructura(None, MOTIVO_CUOTA)

        if respuesta.status_code != 200:
            logger.warning("gemini_error", estado=respuesta.status_code)
            return ResultadoEstructura(None, MOTIVO_SIN_RESPUESTA)

        datos = self._leer(respuesta.json())
        return ResultadoEstructura(datos, None if datos else MOTIVO_SIN_RESPUESTA)

    def _leer(self, cuerpo: dict) -> dict | None:
        try:
            partes = cuerpo["candidates"][0]["content"]["parts"]
            # Se busca la PRIMERA parte que traiga texto en lugar de
            # coger `parts[0]` a ciegas: la respuesta de este modelo
            # incluye tambien partes de razonamiento
            # (`thoughtSignature`), y dar por hecho que el JSON esta en
            # la primera posicion es una suposicion sobre el orden que
            # nadie ha prometido.
            # `StopIteration` entra en el `except` a proposito: si
            # ninguna parte trae texto, el modelo no ha contestado nada
            # utilizable, y eso es exactamente el mismo caso que una
            # respuesta con la forma cambiada.
            texto = next(p["text"] for p in partes if "text" in p)
            datos = json.loads(texto)
        except (KeyError, IndexError, TypeError, ValueError, StopIteration) as exc:
            logger.warning("gemini_respuesta_inesperada", error=type(exc).__name__)
            return None

        if not isinstance(datos, dict) or "incidencias" not in datos:
            logger.warning("gemini_estructura_incompleta")
            return None

        return datos
