"""
Un reintento acotado para las llamadas a terceros.

POR QUE ESTO NO ES TAPAR UN PROBLEMA
────────────────────────────────────
Las dos APIs de las que depende este servicio fallan de forma
transitoria por su cuenta, sin que nadie haya hecho nada mal. Medido
aqui, contra las dos de verdad:

  · Gemini devolvio `503 UNAVAILABLE` con el mensaje "This model is
    currently experiencing high demand" en una peticion y `200` en la
    siguiente, con el mismo cuerpo.
  · El handshake TLS con Deepgram se rompio de forma intermitente desde
    esta red -1 o 2 de cada 5 conexiones prosperaban-, con certificado
    legitimo de Let's Encrypt y con los dos almacenes de confianza.

Perder el parte de un turno entero porque la primera de dos peticiones
cayo en un pico de demanda ajeno seria un mal reparto del coste: el
reintento cuesta medio segundo y lo que evita es que alguien tenga que
volver a dictarlo.

LO QUE ESTE REINTENTO NO HACE
─────────────────────────────
No enmascara un fallo persistente. Son dos o tres intentos, no diez, y
cuando se agotan la degradacion que ya existia sigue en pie tal cual:
sin transcripcion se devuelve 503 con su codigo para que el parte se
escriba a mano, y sin estructuracion se devuelve la transcripcion sola.

El numero sale de medir, no de elegir un numero redondo. Sondeando la
API real seis veces por modelo, `gemini-3.8-flash` dio 6/6 en un
momento y 2/6 minutos antes, y otros modelos fallaron en las mismas
rachas: no es una propiedad del modelo, es que la carga va por olas.
Contra eso lo que sirve son intentos separados en el tiempo.

Tampoco reintenta lo que no tiene sentido reintentar. Un 401 por una
clave mal puesta o un 413 por un audio demasiado grande dan el mismo
resultado las veces que se pidan, y repetirlos solo anadiria latencia
a un error que ya es definitivo.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

import httpx

#: Estados que merecen otro intento: los que significan "ahora mismo no
#: puedo", no "esto que pides esta mal".
ESTADOS_TRANSITORIOS = frozenset({500, 502, 503, 504})

#: El 429 NO esta en la lista de arriba, y es deliberado.
#:
#: Un 429 es un limite de tasa, no un tropiezo del servidor. Reintentar
#: medio segundo despues vuelve a chocar contra el mismo limite, y ademas
#: lo empuja: cada intento cuenta para la cuota que acaba de agotarse.
#: Es la unica respuesta donde reintentar deja las cosas PEOR que no
#: hacerlo.
#:
#: Se vio en uso real: una estructuracion gasto sus intentos en
#: 503, 429, 503 y acabo degradandose igual, despues de haber contribuido
#: al limite con la peticion del medio.
#:
#: Google manda cuanto habria que esperar dentro del cuerpo del error, y
#: suelen ser decenas de segundos: mas de lo que nadie va a estar mirando
#: una pantalla. Asi que ante un 429 se degrada de inmediato, que es lo
#: que este servicio ya sabe hacer sin perder nada importante.
ESTADO_LIMITE_DE_TASA = 429


async def con_reintento(
    peticion: Callable[[], Awaitable[httpx.Response]],
    *,
    intentos: int = 2,
    espera_s: float = 0.5,
    al_reintentar: Callable[[str], None] | None = None,
) -> httpx.Response:
    """
    Ejecuta `peticion`, repitiendola si el fallo es transitorio.

    La espera CRECE entre intentos, y no por doctrina sino por lo que
    se midio: los 503 de Gemini no llegan sueltos, llegan en rachas de
    varios segundos. Una espera fija y corta cae dentro de la misma
    racha y gasta el intento para nada.

    Si el ultimo intento tambien falla, se devuelve o se propaga tal
    cual: quien llama ya sabe degradarse, y convertir eso en otra cosa
    solo le quitaria informacion.
    """
    espera = espera_s

    for intento in range(intentos):
        ultimo = intento == intentos - 1
        try:
            respuesta = await peticion()
            if respuesta.status_code not in ESTADOS_TRANSITORIOS or ultimo:
                return respuesta
            motivo = f"estado {respuesta.status_code}"
        except httpx.HTTPError as exc:
            if ultimo:
                raise
            motivo = type(exc).__name__

        if al_reintentar is not None:
            al_reintentar(motivo)

        await asyncio.sleep(espera)
        espera *= 3

    # Inalcanzable: el bucle siempre sale por `return` o por `raise` en
    # el ultimo intento. Esta por si alguien toca el rango.
    raise RuntimeError("con_reintento no llego a intentar nada")
