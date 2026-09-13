"""
Evidencia de vida, por frame.

QUE ES ESTO Y QUE NO ES
-----------------------
Esto NO es un detector de ataques de presentacion certificado. Es un
conjunto de medidas baratas sobre la textura del rostro, pensadas para
que el Access Service decida con ellas. No esta validado contra ningun
conjunto de ataques reales, y por eso no emite ningun veredicto: emite
NUMEROS.

Quien decide es el Access Service, igual que con todo lo demas. Este
servicio no conoce identidades ni politicas (ADR 0002), y un umbral de
seguridad es politica.

EN QUE SE APOYA
---------------
Una cara real fotografiada por la camara y una FOTO de esa cara vuelta
a fotografiar no tienen el mismo espectro de frecuencias:

  · Una reimpresion o una foto de una foto pasa dos veces por un
    proceso de captura y de compresion. Cada pasada recorta altas
    frecuencias, asi que el resultado es mas pobre en detalle fino que
    una captura directa, aunque a simple vista parezca nitida.

  · Una PANTALLA anade lo contrario: su rejilla de pixeles es un patron
    periodico, y al fotografiarla aparece como picos aislados y fuertes
    en el espectro -el efecto muare-. Un rostro real tiene un espectro
    suave, sin picos.

Son dos senales que apuntan en direcciones OPUESTAS y por eso se miden
por separado en lugar de combinarse en un numero: un detalle fino bajo
sugiere una reimpresion, y un pico fuerte sugiere una pantalla. Una
sola cifra que mezclara ambas se anularia sola en el caso de la
pantalla, que baja una y sube la otra.

MEDIDO SOBRE DEGRADACIONES SINTETICAS
-------------------------------------
Estas dos medidas no se eligieron de oido. Sobre un rostro real al que
se le aplicaron las dos degradaciones a proposito:

    caso                    detalle fino    pico periodico
    captura directa               0.563              14
    foto de una foto              0.320              38
    foto de una foto (q90)        0.292              48
    pantalla                      0.627             149
    pantalla + recaptura          0.504             571

El pico sube tambien con la recompresion JPEG, porque los bloques de
8x8 son un patron periodico tambien. No es un defecto: volver a
comprimir es justo lo que le pasa a una imagen recapturada.

ADVERTENCIA SOBRE ESTOS NUMEROS: salen de UNA imagen y de degradaciones
FABRICADAS. Dicen que las senales reaccionan, que es el minimo para
molestarse en calcularlas. NO dicen nada sobre la separacion que habria
frente a ataques reales, y cualquier umbral que se ponga a partir de
aqui es provisional hasta medirlo con ataques de verdad.

POR QUE SOBRE EL RECORTE ALINEADO
---------------------------------
Se mide sobre el mismo recorte de 112x112 que ve ArcFace, por el mismo
motivo que `quality.py` normaliza el tamano antes de medir la nitidez:
el numero tiene que significar lo mismo para una cara cercana y para
una lejana. Sin normalizar, la distancia a la camara cambiaria la
medida mas que el ataque.

LO QUE ESTO NO DETECTA
----------------------
Un video reproducido en una pantalla de buena calidad, una mascara, o
una foto impresa en papel mate de alta resolucion sostenida quieta. No
es una lista exhaustiva: es que sin un conjunto de ataques con el que
medir, cualquier afirmacion sobre lo que detecta seria inventada.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# Tamano al que se normaliza el recorte antes de medir. Coincide con la
# entrada de ArcFace: se mide exactamente la imagen que produce el
# embedding, no una version distinta de ella.
_REFERENCE_SIZE = 112

# Radio -normalizado a [0, 1] desde el centro del espectro- a partir del
# cual se considera "detalle fino". Por debajo de 0.08 esta la
# iluminacion y la forma general de la cara, que no aportan nada aqui.
_LOW_CUT = 0.08
_HIGH_CUT = 0.35


@dataclass(frozen=True)
class LivenessEvidence:
    """
    Medidas crudas. NINGUNA es un veredicto.

    Se devuelven por separado a proposito: combinarlas en un solo
    numero aqui obligaria a elegir pesos, y elegir pesos es decidir
    politica de seguridad en el servicio que no tiene politica.
    """

    #: Proporcion de energia en las frecuencias altas frente al total
    #: util. Mas bajo = imagen mas pobre en detalle fino de lo esperable
    #: en una captura directa.
    detail_ratio: float

    #: Fuerza del pico periodico mas marcado, relativa a la mediana de
    #: su banda. Mas alto = patron repetitivo, tipico de una pantalla.
    pattern_peak: float


def _spectrum(crop_bgr: np.ndarray) -> np.ndarray:
    """Magnitud del espectro centrado del recorte normalizado."""
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    if gray.shape != (_REFERENCE_SIZE, _REFERENCE_SIZE):
        gray = cv2.resize(
            gray, (_REFERENCE_SIZE, _REFERENCE_SIZE), interpolation=cv2.INTER_AREA
        )

    # La ventana de Hann evita que los bordes del recorte -un corte
    # brusco- inyecten energia en todas las frecuencias y enmascaren lo
    # que se quiere medir. Sin ella, el borde domina el espectro.
    ventana = np.outer(np.hanning(_REFERENCE_SIZE), np.hanning(_REFERENCE_SIZE))
    normalizado = gray.astype(np.float32)
    normalizado -= normalizado.mean()

    return np.abs(np.fft.fftshift(np.fft.fft2(normalizado * ventana)))


def _radios() -> np.ndarray:
    """Distancia normalizada de cada punto del espectro a su centro."""
    eje = np.linspace(-1.0, 1.0, _REFERENCE_SIZE)
    xx, yy = np.meshgrid(eje, eje)
    return np.sqrt(xx**2 + yy**2)


def assess(aligned_face_112: np.ndarray) -> LivenessEvidence:
    """
    Mide la evidencia de vida de un recorte alineado.

    Nunca lanza: un fallo midiendo no puede tumbar el reconocimiento de
    un frame. Ante la duda devuelve valores neutros, y la decision de
    que hacer con "no se sabe" es del Access Service.
    """
    if aligned_face_112 is None or aligned_face_112.size == 0:
        return LivenessEvidence(detail_ratio=0.0, pattern_peak=0.0)

    try:
        espectro = _spectrum(aligned_face_112)
        radios = _radios()

        util = radios > _LOW_CUT
        alta = radios > _HIGH_CUT

        energia_util = float(espectro[util].sum())
        if energia_util <= 0.0:
            return LivenessEvidence(detail_ratio=0.0, pattern_peak=0.0)

        detail_ratio = float(espectro[alta].sum()) / energia_util

        # El pico se busca SOLO en la banda alta, y esto se midio: con
        # la banda util entera, la estructura de la propia cara domina
        # el maximo y el numero apenas distingue una pantalla de una
        # captura directa (137 frente a 99). Restringido a la banda
        # alta, la separacion pasa a ser de un orden de magnitud (149
        # frente a 14).
        #
        # Se compara con la MEDIANA de la banda y no con la media: la
        # media la arrastra el propio pico que se busca, y un patron
        # fuerte se disimularia a si mismo.
        banda = espectro[alta]
        mediana = float(np.median(banda))
        pattern_peak = float(banda.max()) / mediana if mediana > 0 else 0.0

        return LivenessEvidence(
            detail_ratio=round(detail_ratio, 6),
            pattern_peak=round(pattern_peak, 3),
        )
    except Exception:  # noqa: BLE001
        # Mismo criterio que el resto del pipeline: un rostro que falla
        # no tumba el frame. Valores neutros y que decida quien decide.
        return LivenessEvidence(detail_ratio=0.0, pattern_peak=0.0)
