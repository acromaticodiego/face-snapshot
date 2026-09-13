"""
Logging estructurado.

REGLA DE PRIVACIDAD, Y AQUI ES MAS ESTRICTA QUE EN EL VISION SERVICE:
nunca se registra el audio, ni la transcripcion, ni el texto
estructurado. Solo metadatos -cuantos bytes, cuanto tardo, cuantas
incidencias salieron-.

El motivo es que un parte de relevo de turno contiene exactamente lo
que un registro de seguridad no debe filtrar: quien entro, a que hora,
que fallo y donde. Si eso acaba en los logs del contenedor, la promesa
de que el audio se descarta no vale nada, porque su contenido se habria
quedado igualmente.
"""

import logging
import sys

import structlog


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level.upper())
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.dev.ConsoleRenderer(colors=False),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str):
    return structlog.get_logger(name)
