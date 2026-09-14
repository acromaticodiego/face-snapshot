#!/usr/bin/env python3
"""
Mide la senal de deteccion de vida contra un conjunto de ataque.

    python scripts/medir_vida.py /tmp/conjunto

Se ejecuta DENTRO del contenedor del Vision Service y habla con el
servicio por HTTP en localhost, para reutilizar los modelos ya
cargados: cargarlos otra vez costaria medio minuto por nada.

QUE RESPONDE, Y POR QUE ESA PREGUNTA
------------------------------------
Una sola: **existe algun umbral sobre estas senales que separe una cara
real de una foto en una pantalla.** No "que tal van" ni "cual es mejor":
si la respuesta es que no, la senal se retira y no hay nada que
calibrar.

El 2026-09-13 se midio con siete frames sueltos y salio que no solo no
separan, sino que apuntan AL REVES. Esto es lo mismo con un conjunto de
verdad, y con el detalle que aquel no podia dar.

LAS TRES SENALES QUE SE MIDEN
-----------------------------
`detalle fino` y `pico periodico` son las dos espectrales originales,
que quedaron REFUTADAS contra este mismo conjunto (ADR 0014). Se siguen
midiendo para poder ver la comparacion, no porque decidan nada.

`spoofScore` es MiniFASNet, la que decide hoy. Es una probabilidad de
«cara real» en [0, 1], asi que un ataque deberia dar BAJO.

LA MITAD RESERVADA, QUE NO ES ADORNO ESTADISTICO
------------------------------------------------
El informe elige el mejor corte posible sobre los propios datos, y eso
es optimista a proposito. Pero un corte elegido asi puede mentir de una
forma concreta y ya vista: con la sesion 1 sola, el pico periodico daba
0 % de error, y ese mismo corte aplicado a la sesion 2 dio BPCER 20 % y
APCER 25 %. Una de cada cinco personas fuera del edificio.

Por eso el informe trae ademas una seccion que parte el conjunto por
SESION DE CAPTURA -usando las marcas de tiempo del manifiesto-, elige el
corte en la primera y lo aplica a la segunda, que no participo en
elegirlo. Es la comprobacion que cazo aquel error, y esta aqui dentro
para que no dependa de que alguien se acuerde de hacerla.

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
from datetime import datetime
from pathlib import Path

SERVICIO = "http://localhost:8000/api/v1/faces/analyze"
CLASES = ("real", "pantalla")
VARIANTES = ("terminal", "nativo")

# Las senales que se miden.
#
#   clave            nombre del campo en el bloque de resultados
#   ataque_es_menor  True si un ataque deberia dar un valor MAS BAJO
#   decide           si su resultado manda en el veredicto
#
# Solo `spoof` decide. Las dos espectrales se siguen midiendo -el Vision
# Service las sigue enviando- porque poder ver las tres juntas es lo que
# hace comprobable la afirmacion «la vieja no separaba y esta si»; pero
# ya no decide nadie con ellas, asi que no pueden suspender el informe.
SENALES = (
    (
        "detalle fino",
        "detalle",
        True,
        False,
        "deberia CAER con una recaptura: una foto de una foto pierde detalle",
    ),
    (
        "pico periodico",
        "pico",
        False,
        False,
        "deberia SUBIR con una pantalla: su rejilla es un patron repetitivo",
    ),
    (
        "spoofScore (MiniFASNet)",
        "spoof",
        True,
        True,
        "es la probabilidad de cara real: un ataque deberia dar BAJO",
    ),
)


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
    """Recorre el conjunto y recoge las senales de cada imagen."""
    resultados: dict = {}

    for clase in CLASES:
        for variante in VARIANTES:
            carpeta = directorio / clase / variante
            imagenes = sorted(carpeta.glob("*.jpg")) if carpeta.is_dir() else []

            archivos: list[str] = []
            detalle: list[float] = []
            pico: list[float] = []
            spoof: list[float] = []
            archivos_spoof: list[str] = []
            sin_cara = 0
            varias_caras = 0
            sin_spoof = 0

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
                archivos.append(imagen.name)
                detalle.append(float(vida.get("detailRatio", 0.0)))
                pico.append(float(vida.get("patternPeak", 0.0)))

                # `spoofScore` viaja AUSENTE cuando no se pudo medir, y
                # nunca como 0.0: un cero significaria «ataque
                # segurisimo». Meterlo en la lista como cero inventaria
                # un ataque perfecto por cada fallo de medida y haria
                # parecer que la senal separa mejor de lo que separa.
                puntuacion = vida.get("spoofScore")
                if puntuacion is None:
                    sin_spoof += 1
                else:
                    spoof.append(float(puntuacion))
                    archivos_spoof.append(imagen.name)

            resultados[(clase, variante)] = {
                "total": len(imagenes),
                "medidas": len(detalle),
                "sin_cara": sin_cara,
                "varias_caras": varias_caras,
                "sin_spoof": sin_spoof,
                "archivos": archivos,
                "detalle": detalle,
                "pico": pico,
                "spoof": spoof,
                "archivos_spoof": archivos_spoof,
            }

    return resultados


def sesiones(directorio: Path) -> dict[str, int]:
    """
    Reparte cada archivo del manifiesto en una sesion de captura.

    Una «sesion» es una tanda seguida de disparos. Se detectan por los
    huecos entre marcas de tiempo: dentro de una tanda las capturas van
    separadas por segundos, y entre tandas hay minutos. El umbral son
    cinco minutos, que es holgado para lo primero y estrecho para lo
    segundo.

    Importa porque dos sesiones distintas traen luz, distancia y postura
    distintas, y un corte que solo funciona dentro de una sesion es un
    corte que ha aprendido la sesion, no el ataque.
    """
    manifiesto = directorio / "manifiesto.jsonl"
    if not manifiesto.is_file():
        return {}

    filas = []
    for linea in manifiesto.read_text(encoding="utf-8").splitlines():
        if not linea.strip():
            continue
        try:
            dato = json.loads(linea)
            filas.append(
                (
                    datetime.fromisoformat(dato["capturadoEn"].replace("Z", "+00:00")),
                    dato["archivo"],
                )
            )
        except (ValueError, KeyError):
            continue

    if not filas:
        return {}

    filas.sort()
    reparto: dict[str, int] = {}
    sesion = 1
    anterior = filas[0][0]
    for momento, archivo in filas:
        if (momento - anterior).total_seconds() > 300:
            sesion += 1
        reparto[archivo] = sesion
        anterior = momento

    return reparto


def aplicar_corte(
    reales: list[float],
    ataques: list[float],
    corte: float,
    ataque_es_menor: bool,
) -> tuple[float, float]:
    """APCER y BPCER de un corte YA elegido. No elige nada."""
    if ataque_es_menor:
        apcer = sum(1 for v in ataques if v >= corte) / len(ataques)
        bpcer = sum(1 for v in reales if v < corte) / len(reales)
    else:
        apcer = sum(1 for v in ataques if v <= corte) / len(ataques)
        bpcer = sum(1 for v in reales if v > corte) / len(reales)
    return apcer, bpcer


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

        apcer, bpcer = aplicar_corte(reales, ataques, corte, ataque_es_menor)

        if mejor is None or apcer + bpcer < mejor[1] + mejor[2]:
            mejor = (corte, apcer, bpcer)

    return mejor


def _pares(bloque: dict, clave: str) -> list[tuple[str, float]]:
    """Empareja cada valor con el archivo del que salio."""
    nombres = bloque.get("archivos_spoof" if clave == "spoof" else "archivos", [])
    return list(zip(nombres, bloque.get(clave, [])))


def reservada(resultados: dict, reparto: dict[str, int]) -> int:
    """
    Elige el corte en la primera sesion y lo aplica a las demas.

    ESTO ES LO QUE CAZO EL ERROR ANTERIOR
    ─────────────────────────────────────
    El mejor corte sobre todos los datos siempre queda bonito, porque se
    ha elegido sabiendo las respuestas. La pregunta util es otra: un
    corte fijado ayer, ¿sigue valiendo manana, con otra luz y otra
    distancia?

    Con el pico periodico la respuesta fue que no, y por goleada: 0 % de
    error dentro de la sesion 1, y BPCER 20 % con APCER 25 % al aplicarlo
    a la sesion siguiente.

    Las sesiones posteriores a la primera se juntan todas en «la
    reserva»: lo que hace falta es material que NO participara en elegir
    el corte, y da igual de cuantas tandas venga.

    Devuelve el numero de indicios negativos encontrados.
    """
    print()
    print("  EL CORTE DE LA PRIMERA SESION, APLICADO A LA RESERVA")
    print("  " + "─" * 66)

    if not reparto:
        for linea in [
            "  NO SE PUDO COMPROBAR: falta manifiesto.jsonl, que es de donde",
            "  salen las marcas de tiempo que separan una sesion de otra.",
            "  El informe de arriba sigue siendo valido, pero es el caso",
            "  optimista: elige el corte sabiendo ya las respuestas.",
        ]:
            print(linea)
        return 0

    total_sesiones = len(set(reparto.values()))
    print(
        f"  {total_sesiones} sesiones de captura detectadas. Entrena la 1, se "
        f"comprueba contra el resto."
    )

    problemas = 0
    comprobaciones = 0

    # Se comprueban TODAS las senales, tambien las refutadas. Solo las
    # que deciden pueden suspender el informe, pero ver aqui al pico
    # periodico desmoronarse fuera de su sesion es lo que hace que la
    # afirmacion del ADR 0014 se pueda comprobar corriendo esto, en vez
    # de tener que creerse una tabla escrita a mano.
    for senal, clave, ataque_es_menor, decide, _ in SENALES:
        for variante in VARIANTES:
            partido = {}
            for clase in CLASES:
                pares = _pares(resultados[(clase, variante)], clave)
                partido[(clase, "entrena")] = [
                    v for archivo, v in pares if reparto.get(archivo, 1) == 1
                ]
                partido[(clase, "reserva")] = [
                    v for archivo, v in pares if reparto.get(archivo, 1) != 1
                ]

            faltan = [
                f"{clase}/{mitad}"
                for (clase, mitad), valores in partido.items()
                if not valores
            ]
            if faltan:
                print(f"  {senal} · {variante}: sin datos en {', '.join(faltan)}")
                continue

            corte = mejor_corte(
                partido[("real", "entrena")],
                partido[("pantalla", "entrena")],
                ataque_es_menor,
            )
            umbral, apcer_1, bpcer_1 = corte
            apcer_2, bpcer_2 = aplicar_corte(
                partido[("real", "reserva")],
                partido[("pantalla", "reserva")],
                umbral,
                ataque_es_menor,
            )

            if decide:
                comprobaciones += 1
            signo = "<" if ataque_es_menor else ">"
            print()
            etiqueta = "DECIDE" if decide else "refutada"
            print(f"  {senal} · {variante}  [{etiqueta}]")
            print(f"    corte elegido en la sesion 1: rechazar si {clave} {signo} {umbral:.4f}")
            print(
                f"    sesion 1 (lo eligio) : APCER {apcer_1:6.1%}  "
                f"BPCER {bpcer_1:6.1%}   n={len(partido[('real', 'entrena')])}"
                f"+{len(partido[('pantalla', 'entrena')])}"
            )
            print(
                f"    reserva  (no lo vio) : APCER {apcer_2:6.1%}  "
                f"BPCER {bpcer_2:6.1%}   n={len(partido[('real', 'reserva')])}"
                f"+{len(partido[('pantalla', 'reserva')])}"
            )

            if apcer_2 + bpcer_2 > 0.3:
                if decide:
                    problemas += 1
                print(
                    "    -> NO AGUANTA FUERA DE SU SESION: el corte habia "
                    "aprendido la sesion, no el ataque"
                )

    if comprobaciones == 0:
        print()
        for linea in [
            "  NO SE PUDO COMPROBAR nada: hace falta al menos una cara real y",
            "  un ataque en la sesion 1, y otros tantos en alguna posterior.",
            "  Con una sola sesion no hay reserva que valga, y el informe de",
            "  arriba se queda en el caso optimista.",
        ]:
            print(linea)

    return problemas


def informar(resultados: dict, reparto: dict[str, int] | None = None) -> int:
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

    sin_spoof = sum(r["sin_spoof"] for r in resultados.values())
    if sin_spoof:
        print()
        for linea in [
            f"  Aviso: {sin_spoof} rostros SIN puntuacion de MiniFASNet. El",
            "  Vision Service la envia ausente cuando no pudo medirla, y",
            "  aqui se deja fuera en vez de contarla como cero: un cero",
            "  seria un ataque perfecto inventado por cada fallo de medida.",
        ]:
            print(linea)

    problemas = 0

    for senal, clave, ataque_es_menor, decide, explicacion in SENALES:
        print()
        etiqueta = "DECIDE" if decide else "informativa, REFUTADA"
        print(f"  {senal.upper()}  [{etiqueta}]")
        print(f"  {explicacion}")
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
                if decide:
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
                    if decide:
                        problemas += 1
                    print(
                        "      -> INSERVIBLE: ni el mejor corte sobre estos "
                        "mismos datos separa"
                    )

    problemas += reservada(resultados, reparto or {})

    print()
    print("  " + "─" * 66)
    if problemas:
        print(
            f"  VEREDICTO: la senal que decide NO separa ({problemas}\n"
            "  indicios). No es un problema de umbral. Hay que sustituirla,\n"
            "  y las vias estan en docs/adr/0010-deteccion-de-vida.md.\n"
            "\n"
            "  Ojo: las senales marcadas «informativa, REFUTADA» no cuentan\n"
            "  para este veredicto. Ya se sabe que no separan (ADR 0014) y\n"
            "  ya no decide nadie con ellas; se siguen imprimiendo para\n"
            "  poder comparar."
        )
        return 1

    print(
        f"  VEREDICTO: sobre ESTE conjunto ({medidas} medidas) la senal que\n"
        "  decide separa, y aguanta fuera de la sesion en la que se eligio\n"
        "  el corte. Ojo con el tamano de muestra antes de encender HARD:\n"
        "  unas decenas de imagenes de una persona y un movil no son una\n"
        "  validacion, y la ISO/IEC 30107-3 pide bastante mas que esto.\n"
        "  Falta, como minimo, foto impresa, video en pantalla y mas de\n"
        "  una persona."
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

    return informar(medir(directorio), sesiones(directorio))


if __name__ == "__main__":
    sys.exit(main())
