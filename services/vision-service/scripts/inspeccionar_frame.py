#!/usr/bin/env python3
"""
Pasa UN frame por los dos endpoints y devuelve las dos vistas juntas.

    cat frame.jpg | python scripts/inspeccionar_frame.py

Se ejecuta DENTRO del contenedor del Vision Service y habla con el
servicio por localhost, igual que `medir_vida.py`, para reutilizar los
modelos ya cargados.

POR QUE LOS DOS ENDPOINTS Y NO UNO
----------------------------------
Responden preguntas distintas y la interesante esta en la diferencia:

  /faces/detect    TODO lo que el detector encontro, sin filtrar. Es la
                   unica forma de ver una caja que se descarto y con
                   que puntuacion.
  /faces/analyze   solo lo que paso el control de calidad, y con los
                   numeros que el sistema usa de verdad: nitidez,
                   tamano y puntuacion de vida.

Lo que aparece en `detect` y no en `analyze` es exactamente lo que el
filtro esta tirando. Lo que aparece en los dos es lo que llega a la
decision de acceso -y si eso incluye un cuadro de la pared, ahi esta el
problema, no en la interfaz-.

Las cajas se emparejan por solapamiento (IoU) y no por orden: los dos
endpoints no garantizan el mismo orden, y emparejar por indice haria
que los numeros de una caja se atribuyeran a otra. Eso no daria error,
daria un informe que miente.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import uuid

BASE = "http://localhost:8000/api/v1"


def enviar(ruta: str, jpeg: bytes) -> dict:
    limite = uuid.uuid4().hex
    cuerpo = b"".join(
        [
            f"--{limite}\r\n".encode(),
            b'Content-Disposition: form-data; name="file"; filename="f.jpg"\r\n',
            b"Content-Type: image/jpeg\r\n\r\n",
            jpeg,
            f"\r\n--{limite}--\r\n".encode(),
        ]
    )
    peticion = urllib.request.Request(
        f"{BASE}{ruta}",
        data=cuerpo,
        headers={"Content-Type": f"multipart/form-data; boundary={limite}"},
    )
    with urllib.request.urlopen(peticion, timeout=60) as respuesta:
        return json.load(respuesta)


def iou(a: dict, b: dict) -> float:
    """Solapamiento entre dos cajas, para emparejarlas sin fiarse del orden."""
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]

    ix = max(0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0, min(ay2, by2) - max(a["y"], b["y"]))
    interseccion = ix * iy
    if interseccion == 0:
        return 0.0

    union = a["width"] * a["height"] + b["width"] * b["height"] - interseccion
    return interseccion / union if union > 0 else 0.0


def main() -> int:
    jpeg = sys.stdin.buffer.read()
    if not jpeg:
        print(json.dumps({"error": "frame vacio"}))
        return 1

    try:
        crudo = enviar("/faces/detect", jpeg)
        fino = enviar("/faces/analyze", jpeg)
    except urllib.error.HTTPError as exc:
        print(json.dumps({"error": f"HTTP {exc.code}"}))
        return 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}))
        return 1

    aceptadas = fino.get("faces", [])
    cajas = []

    for deteccion in crudo.get("faces", []):
        # El mejor emparejamiento por solapamiento, y solo si de verdad
        # se solapan: 0.5 es holgado para dos vistas del MISMO frame,
        # donde las cajas son identicas salvo por el recorte a los
        # limites de la imagen.
        pareja = None
        mejor = 0.5
        for cara in aceptadas:
            valor = iou(deteccion["bbox"], cara["bbox"])
            if valor > mejor:
                mejor, pareja = valor, cara

        caja = {
            "bbox": deteccion["bbox"],
            "score": deteccion["detectionScore"],
            "aceptada": pareja is not None,
        }
        if pareja is not None:
            caja["nitidez"] = pareja["quality"]["blurScore"]
            caja["ancho"] = pareja["quality"]["faceWidthPx"]
            caja["alto"] = pareja["quality"]["faceHeightPx"]
            caja["truncada"] = pareja["quality"]["truncated"]
            caja["vida"] = pareja.get("liveness", {}).get("spoofScore")
        else:
            caja["ancho"] = deteccion["bbox"]["width"]
            caja["alto"] = deteccion["bbox"]["height"]

        cajas.append(caja)

    print(
        json.dumps(
            {
                "ancho": crudo.get("imageWidth"),
                "alto": crudo.get("imageHeight"),
                "cajas": sorted(cajas, key=lambda c: -c["score"]),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
