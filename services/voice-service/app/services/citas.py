"""
Comprueba que cada incidencia esta respaldada por lo que se dijo.

EL PROBLEMA QUE RESUELVE
────────────────────────
A un modelo de lenguaje se le puede pedir que no invente. No se le
puede creer. En un parte de relevo de turno eso importa mas que en casi
cualquier otro texto: es el documento que alguien lee cuando algo ha
salido mal, y una incidencia inventada manda a una persona a investigar
un hecho que nunca ocurrio.

Asi que al modelo se le exige algo verificable en lugar de algo
prometido: que por cada incidencia senale UN FRAGMENTO LITERAL de la
transcripcion. Y despues se comprueba aqui si ese fragmento existe. La
instruccion "no inventes" no se puede medir; "ensename donde lo leiste"
si.

POR QUE SE COMPARA POR PALABRAS Y NO CARACTER A CARACTER
────────────────────────────────────────────────────────
Una comparacion exacta marcaria como no respaldadas casi todas las
citas buenas: basta con que el modelo se coma una coma o cambie unas
comillas. Y una comparacion demasiado laxa -por parecido difuso- daria
por buena una cita reescrita, que es justo lo que se quiere detectar.

El punto medio es comparar la SECUENCIA DE PALABRAS, ignorando
mayusculas y puntuacion: un fragmento copiado sigue coincidiendo aunque
cambie la puntuacion, y un fragmento redactado de nuevo no, porque
cambiaria alguna palabra o su orden.

Los acentos SI cuentan. En espanol distinguen palabras distintas, y
quitarlos para comparar seria aflojar la comprobacion sin ganar nada:
la transcripcion viene acentuada y una cita copiada de ella tambien.

QUE SE HACE CON UNA CITA QUE NO CUADRA
──────────────────────────────────────
Marcarla, no borrarla. Borrarla esconderia que el modelo se invento
algo, y esa es informacion util para quien revisa el borrador y para
quien decida manana si esto merece seguir en el sistema.
"""

from __future__ import annotations

import re
import unicodedata

# Todo lo que no sea letra, numero o espacio se convierte en separador.
# `\w` con unicode ya incluye las letras acentuadas y la enye.
_NO_PALABRA = re.compile(r"[^\w\s]", flags=re.UNICODE)
_ESPACIOS = re.compile(r"\s+")


def normalizar(texto: str) -> str:
    """
    Deja el texto como secuencia de palabras en minusculas.

    Se normaliza ademas a NFC porque la transcripcion y la respuesta del
    modelo pueden venir con los acentos compuestos de forma distinta -la
    misma "a" acentuada puede ser un caracter o dos-, y dos cadenas que
    se ven identicas no compararian iguales.
    """
    if not texto:
        return ""
    compuesto = unicodedata.normalize("NFC", texto)
    sin_puntuacion = _NO_PALABRA.sub(" ", compuesto)
    return _ESPACIOS.sub(" ", sin_puntuacion).strip().casefold()


def cita_respaldada(cita: str, transcripcion: str) -> bool:
    """
    Dice si la cita aparece en la transcripcion.

    Una cita vacia nunca esta respaldada: el modelo tenia que senalar
    donde lo leyo y no lo hizo.
    """
    aguja = normalizar(cita)
    if not aguja:
        return False
    return aguja in normalizar(transcripcion)


def verificar_incidencias(
    incidencias: list[dict], transcripcion: str
) -> tuple[list[dict], int]:
    """
    Anade `citaVerificada` a cada incidencia.

    Devuelve la lista y cuantas quedaron sin respaldo, que es el numero
    que interesa vigilar: si empieza a subir, o el modelo ha cambiado de
    comportamiento o el parte que le llega no se parece a lo que espera.
    """
    revisadas: list[dict] = []
    sin_respaldo = 0

    for incidencia in incidencias:
        cita = str(incidencia.get("citaLiteral", ""))
        respaldada = cita_respaldada(cita, transcripcion)
        if not respaldada:
            sin_respaldo += 1
        revisadas.append({**incidencia, "citaVerificada": respaldada})

    return revisadas, sin_respaldo
