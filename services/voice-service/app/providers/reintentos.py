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
No enmascara un fallo persistente. Son DOS intentos, no diez, y si el
segundo falla la degradacion que ya existia sigue en pie tal cual: sin
transcripcion se devuelve 503 con su codigo para que el parte se
escriba a mano, y sin estructuracion se devuelve la transcripcion sola.

Tampoco reintenta lo que no tiene sentido reintentar. Un 401 por una
clave mal puesta o un 413 por un audio demasiado grande dan el mismo
resultado las veces que se pidan, y repetirlos solo anadiria latencia
a un error que ya es definitivo.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

import httpx

#: Estados que merecen un segundo intento. Son los que significan
#: "ahora no puedo", no "esto que pides esta mal".
ESTADOS_TRANSITORIOS = frozenset({429, 500, 502, 503, 504})


async def con_reintento(
    peticion: Callable[[], Awaitable[httpx.Response]],
    *,
    espera_s: float = 0.5,
    al_reintentar: Callable[[str], None] | None = None,
) -> httpx.Response:
    """
    Ejecuta `peticion`, y la repite UNA vez si el fallo es transitorio.

    Si el segundo intento tambien lanza un error de transporte, se
    propaga: quien llama ya sabe degradarse, y convertir ese error en
    algo distinto solo le quitaria informacion.
    """
    try:
        respuesta = await peticion()
        if respuesta.status_code not in ESTADOS_TRANSITORIOS:
            return respuesta
        motivo = f"estado {respuesta.status_code}"
    except httpx.HTTPError as exc:
        motivo = type(exc).__name__

    if al_reintentar is not None:
        al_reintentar(motivo)

    # Una espera corta y fija. No hay retroceso exponencial porque con
    # un solo reintento no habria donde aplicarlo, y alargarla mas
    # empujaria la peticion contra el plazo del cliente.
    await asyncio.sleep(espera_s)
    return await peticion()
