#!/usr/bin/env python3
"""
Mide la senal de deteccion de vida contra un conjunto de ataque.

    python scripts/medir_vida.py /tmp/conjunto

Se ejecuta DENTRO del contenedor del Vision Service y habla con el
servicio por HTTP en localhost, para reutilizar los modelos ya
cargados: cargarlos otra vez costaria medio minuto por nada.

QUE RESPONDE, Y POR QUE ESA PREGUNTA
------------------------------------
Una sola: **existe algun umbral sobre estas dos senales que separe una
cara real de una foto en una pantalla.** No "que tal van" ni "cual es
mejor": si la respuesta es que no, la senal se retira y no hay nada que
calibrar.

El 2026-09-13 se midio con siete frames sueltos y salio que no solo no
separan, sino que apuntan AL REVES. Esto es lo mismo con un conjunto de
verdad, y con el detalle que aquel no podia dar.

POR QUE SE MIDEN LAS DOS VARIANTES
----------------------------------
`terminal` es lo que el sistema ve hoy: 640 px de ancho y calidad JPEG
0.75. `nativo` es el frame completo de la camara.

Si la senal separa en `nativo` y no en `terminal`, la conclusion NO es
"la senal sirve": es que habria que cambiar lo que el terminal envia, y
eso es una decision con coste -mas ancho de banda y mas tiempo de
detector por frame- que hay que tomar sabiendo cuanto se gana. Sin
medir las dos, esa pregunta no se puede ni plantear.

LO QUE ESTE SCRIPT NO HACE
--------------------------
No elige umbrales ni los escribe en ningun sitio. Imprime numeros. La
politica vive en el Access Service y la decide una persona mirando
esto, igual que con el umbral de similitud.
"""

from __future__ import annotations

import json
import statistics
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

SERVICIO = "http://localhost:8000/api/v1/faces/analyze"
CLASES = ("real", "pantalla")
VARIANTES = ("terminal", "nativo")


def analizar(ruta: Path) -> dict | None:
    """Manda una imagen al servicio y devuelve lo que midio."""
    limite = uuid.uuid4().hex
    cuerpo = b"".join(
        [
            f"--{limite}\r\n".encode(),
            b'Content-Disposition: form-data; name="file"; '
            + f'filename="{ruta.name}"\r\n'.encode(),
            b"Content-Type: image/jpeg\r\n\r\n",
            ruta.read_bytes(),
            f"\r\n--{limite}--\r\n".encode(),
        ]
    )

    peticion = urllib.request.Request(
        SERVICIO,
        data=cuerpo,
        headers={"Content-Type": f"multipart/form-data; boundary={limite}"},
    )

    try:
        with urllib.request.urlopen(peticion, timeout=120) as respuesta:
            return json.load(respuesta)
    except urllib.error.HTTPError as exc:
        print(f"    {ruta.name}: HTTP {exc.code}", file=sys.stderr)
        return None


def medir(directorio: Path) -> dict:
    """Recorre el conjunto y recoge las dos senales de cada imagen."""
    resultados: dict = {}

    for clase in CLASES:
        for variante in VARIANTES:
            carpeta = directorio / clase / variante
            imagenes = sorted(carpeta.glob("*.jpg")) if carpeta.is_dir() else []

            detalle: list[float] = []
            pico: list[float] = []
            sin_cara = 0
            varias_caras = 0

            for imagen in imagenes:
                datos = analizar(imagen)
                if datos is None:
                    sin_cara += 1
                    continue

                caras = datos.get("faces", [])
                if len(caras) == 0:
                    # Es el modo de fallo que ya aparecio antes: el
                    # detector deja de encontrar la cara. Se cuenta
                    # aparte porque una imagen sin cara no dice nada
                    # sobre la senal, y promediarla la ensuciaria.
                    sin_cara += 1
                    continue
                if len(caras) > 1:
                    varias_caras += 1

                vida = caras[0].get("liveness", {})
                detalle.append(float(vida.get("detailRatio", 0.0)))
                pico.append(float(vida.get("patternPeak", 0.0)))

            resultados[(clase, variante)] = {
                "total": len(imagenes),
                "medidas": len(detalle),
                "sin_cara": sin_cara,
                "varias_caras": varias_caras,
                "detalle": detalle,
                "pico": pico,
            }

    return resultados


def resumen(valores: list[float]) -> str:
    if not valores:
        return "sin datos"
    if len(valores) == 1:
        return f"{valores[0]:.4f} (n=1)"
    return (
        f"{statistics.mean(valores):.4f} ± {statistics.stdev(valores):.4f}  "
        f"[{min(valores):.4f} – {max(valores):.4f}]"
    )


def mejor_corte(reales: list[float], ataques: list[float], ataque_es_menor: bool):
    """
    El umbral que menos se equivoca, y cuanto se equivoca.

    Se prueban todos los cortes posibles -entre cada par de valores
    consecutivos- y se devuelve el que minimiza la suma de los dos
    errores. Es optimista a proposito: si NI SIQUIERA el mejor corte
    posible sobre estos mismos datos separa, ningun umbral elegido a
    ciegas lo va a hacer.

    APCER: ataques que pasarian por buenos.
    BPCER: caras reales que se rechazarian.
    """
    if not reales or not ataques:
        return None

    candidatos = sorted(set(reales + ataques))
    mejor = None

    for i in range(len(candidatos) + 1):
        if i == 0:
            corte = candidatos[0] - 1e-9
        elif i == len(candidatos):
            corte = candidatos[-1] + 1e-9
        else:
            corte = (candidatos[i - 1] + candidatos[i]) / 2

        if ataque_es_menor:
            # Se rechaza lo que este POR DEBAJO del corte.
            apcer = sum(1 for v in ataques if v >= corte) / len(ataques)
            bpcer = sum(1 for v in reales if v < corte) / len(reales)
        else:
            # Se rechaza lo que este POR ENCIMA.
            apcer = sum(1 for v in ataques if v <= corte) / len(ataques)
            bpcer = sum(1 for v in reales if v > corte) / len(reales)

        if mejor is None or apcer + bpcer < mejor[1] + mejor[2]:
            mejor = (corte, apcer, bpcer)

    return mejor


def informar(resultados: dict) -> int:
    """
    Imprime el informe y devuelve el codigo de salida.

    OJO CON EL CASO DE CERO MEDIDAS. La primera version daba por bueno
    "la senal separa" cuando el detector no habia encontrado NINGUNA
    cara, porque no encontraba indicios de lo contrario. Un medidor que
    declara exito habiendo medido nada es peor que uno que falla: el
    numero que te da no es optimista, es inventado.
    """
    print()
    print("  CONJUNTO")
    print("  " + "─" * 66)
    for clase in CLASES:
        for variante in VARIANTES:
            r = resultados[(clase, variante)]
            aviso = ""
            if r["sin_cara"]:
                aviso += f"  · {r['sin_cara']} SIN CARA DETECTADA"
            if r["varias_caras"]:
                aviso += f"  · {r['varias_caras']} con varias caras"
            print(
                f"  {clase:9s}/{variante:9s} {r['medidas']:3d} medidas "
                f"de {r['total']:3d}{aviso}"
            )

    # Antes que cualquier estadistica: ¿hay algo medido?
    medidas = sum(r["medidas"] for r in resultados.values())
    sin_cara = sum(r["sin_cara"] for r in resultados.values())

    if medidas == 0:
        print()
        print("  " + "─" * 66)
        for linea in [
            "  NO SE PUDO MEDIR NADA: el detector no encontro ninguna cara",
            f"  en las {sin_cara} imagenes del conjunto.",
            "",
            "  Esto NO dice nada sobre la senal. Suele ser que las caras",
            "  salen demasiado pequenas -el minimo son 80 px de ancho- o",
            "  demasiado lejos. Vuelve a grabar acercandote, con la cara",
            "  ocupando lo que ocuparia al pasar por la puerta.",
        ]:
            print(linea)
        return 2

    if sin_cara:
        print()
        for linea in [
            f"  Aviso: {sin_cara} imagenes sin cara detectada quedan FUERA",
            "  de las medias. No ensucian los numeros, pero si son muchas,",
            "  lo que mide el conjunto ya no es lo que se grabo.",
        ]:
            print(linea)

    problemas = 0

    for senal, clave, ataque_es_menor, explicacion in [
        (
            "detalle fino",
            "detalle",
            True,
            "deberia CAER con una recaptura: una foto de una foto pierde "
            "detalle",
        ),
        (
            "pico periodico",
            "pico",
            False,
            "deberia SUBIR con una pantalla: su rejilla es un patron "
            "repetitivo",
        ),
    ]:
        print()
        print(f"  {senal.upper()}  —  {explicacion}")
        print("  " + "─" * 66)

        for variante in VARIANTES:
            reales = resultados[("real", variante)][clave]
            ataques = resultados[("pantalla", variante)][clave]

            print(f"  {variante}")
            print(f"    cara real : {resumen(reales)}")
            print(f"    pantalla  : {resumen(ataques)}")

            if not reales or not ataques:
                print("    (faltan datos para comparar)")
                continue

            # Lo primero que hay que saber: ¿va en la direccion que
            # deberia? Si no, no hay umbral que valga.
            media_real = statistics.mean(reales)
            media_ataque = statistics.mean(ataques)
            esperado = media_ataque < media_real if ataque_es_menor else (
                media_ataque > media_real
            )

            if not esperado:
                problemas += 1
                print(
                    "    *** LA SENAL APUNTA AL REVES: la pantalla da "
                    f"{'MAS' if media_ataque > media_real else 'MENOS'} que "
                    "la cara real ***"
                )

            corte = mejor_corte(reales, ataques, ataque_es_menor)
            if corte:
                umbral, apcer, bpcer = corte
                signo = "<" if ataque_es_menor else ">"
                print(
                    f"    mejor corte posible: rechazar si {clave} {signo} "
                    f"{umbral:.4f}"
                )
                print(
                    f"      APCER {apcer:6.1%}  (ataques que pasarian)   "
                    f"BPCER {bpcer:6.1%}  (caras reales rechazadas)"
                )
                if apcer + bpcer > 0.3:
                    problemas += 1
                    print(
                        "      -> INSERVIBLE: ni el mejor corte sobre estos "
                        "mismos datos separa"
                    )

    print()
    print("  " + "─" * 66)
    if problemas:
        print(
            f"  VEREDICTO: la senal actual NO separa ({problemas} indicios).\n"
            "  No es un problema de umbral. Hay que sustituirla, y las dos\n"
            "  vias estan en docs/adr/0010-deteccion-de-vida.md."
        )
        return 1

    print(
        f"  VEREDICTO: sobre ESTE conjunto ({medidas} medidas) la senal\n"
        "  separa. Ojo con el tamano de muestra antes de encender HARD:\n"
        "  unas decenas de imagenes de una sola sesion no son una\n"
        "  validacion, y la ISO/IEC 30107-3 pide bastante mas que esto."
    )
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print("uso: python scripts/medir_vida.py <directorio>", file=sys.stderr)
        return 2

    directorio = Path(sys.argv[1])
    if not directorio.is_dir():
        print(f"no existe: {directorio}", file=sys.stderr)
        return 2

    return informar(medir(directorio))


if __name__ == "__main__":
    sys.exit(main())
