"""
Esquemas Pydantic del Voice Service.

Este modulo ES el contrato: el servicio que produce una respuesta es el
que define su forma (ver docs/adr/0008). Quien lo consuma valida lo que
recibe por su cuenta.

LA PALABRA CLAVE DE TODO ESTE ARCHIVO ES "BORRADOR"
───────────────────────────────────────────────────
Nada de lo que sale de aqui es un registro. Es una PROPUESTA que una
persona tiene que revisar y firmar antes de que se guarde en ningun
sitio. Es el mismo reparto que en el resto del sistema: el Vision
Service mide y el Access Service decide; aqui el modelo propone y la
persona decide.
"""

from typing import Literal

from pydantic import BaseModel, Field

CategoriaIncidencia = Literal[
    "ACCESO", "ALARMA", "MANTENIMIENTO", "SEGURIDAD", "OTRO"
]
Gravedad = Literal["BAJA", "MEDIA", "ALTA"]


class Incidencia(BaseModel):
    """Una novedad que el modelo dice haber encontrado en el parte."""

    titulo: str
    categoria: CategoriaIncidencia
    gravedad: Gravedad

    #: La hora tal y como se dijo ("las tres y cuarto"), sin convertir.
    #: No se normaliza a un instante a proposito: convertir "sobre las
    #: tres" en 03:00:00 inventa una precision que nadie dijo, y en un
    #: parte de turno esa precision falsa acaba en una investigacion.
    horaMencionada: str | None = None

    requiereSeguimiento: bool

    #: Fragmento LITERAL del parte que respalda esta incidencia.
    citaLiteral: str

    #: Si esa cita aparece de verdad en la transcripcion.
    #:
    #: Lo calcula ESTE servicio comparando contra el texto, no lo dice
    #: el modelo. Es la diferencia entre pedirle a un modelo que no
    #: invente y comprobar que no invento: lo primero es una
    #: instruccion, lo segundo es una medida. Una incidencia con
    #: `false` no se descarta -ocultarla seria perder informacion- sino
    #: que se marca, para que quien revisa el borrador sepa cual no
    #: esta respaldada por lo que se dijo.
    citaVerificada: bool


class Estructura(BaseModel):
    resumen: str
    incidencias: list[Incidencia]


class Transcripcion(BaseModel):
    texto: str
    #: Confianza que declara el proveedor, entre 0 y 1.
    confianza: float = Field(ge=0, le=1)
    duracionSegundos: float
    modelo: str


class LogbookDraftResponse(BaseModel):
    """
    Borrador de un parte de relevo: lo que se dijo y como se ordena.

    `estructura` puede venir vacia sin que esto sea un error: si el
    estructurador no responde, la transcripcion por si sola ya sirve
    para dejar constancia del turno, y eso es preferible a devolver un
    fallo y que el vigilante se vaya sin registrar nada.
    """

    transcripcion: Transcripcion
    estructura: Estructura | None = None

    #: Por que no hay estructura, cuando no la hay. `None` si la hay.
    estructuraOmitidaPor: str | None = None

    processingTimeMs: float
    transcribeTimeMs: float
    structureTimeMs: float | None = None


class TranscriptionResponse(BaseModel):
    """Respuesta de transcribir sin estructurar."""

    transcripcion: Transcripcion
    processingTimeMs: float


class HealthResponse(BaseModel):
    """
    Estado del servicio.

    Dice si los proveedores estan CONFIGURADOS, no si responden. Llamar
    a Deepgram y a Gemini en cada sonda los convertiria en dependencia
    de la salud de este contenedor, que es justo lo que el proyecto
    evita en todas partes: ningun tercero puede marcar como enfermo un
    servicio propio. Para saber si responden esta la traza.
    """

    status: str
    service: str
    transcriptionConfigured: bool
    structuringConfigured: bool
    transcriptionModel: str
    structuringModel: str
