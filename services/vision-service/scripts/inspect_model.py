"""
Prueba independiente de rostros.pt  (FASE 5)

Comprueba, sin modificar el modelo:
  · que carga correctamente
  · qué clases tiene
  · qué tarea resuelve (detect / pose / segment / classify)
  · qué tamaño de entrada usa
  · qué formato de salida entrega
  · qué confianza produce sobre una imagen real

Uso:
    python scripts/inspect_model.py
    python scripts/inspect_model.py --image ruta/a/una/foto.jpg

El modelo se abre en modo SOLO LECTURA. Nunca se reentrena ni se sobrescribe.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT.parent.parent / "modelos" / "rostros.pt"


def separator(title: str) -> None:
    print(f"\n{'=' * 66}\n  {title}\n{'=' * 66}")


def inspect(model_path: Path, image_path: Path | None) -> int:
    separator("1. CARGA DEL MODELO")
    print(f"Ruta   : {model_path}")
    if not model_path.exists():
        print(f"ERROR  : el archivo no existe.")
        return 1
    print(f"Tamaño : {model_path.stat().st_size / 1024 / 1024:.2f} MB")

    from ultralytics import YOLO

    model = YOLO(str(model_path))
    print("Estado : cargado correctamente ✓")

    separator("2. IDENTIDAD DEL MODELO")
    task = getattr(model, "task", "desconocida")
    names = model.names if hasattr(model, "names") else {}
    print(f"Tarea            : {task}")
    print(f"Número de clases : {len(names)}")
    print(f"Clases           : {names}")

    args = getattr(model.model, "args", {}) or {}
    if isinstance(args, dict):
        for key in ("model", "data", "epochs", "imgsz", "batch"):
            if key in args:
                print(f"{key:17}: {args[key]}")

    separator("3. ¿DETECTA O IDENTIFICA?")
    n_classes = len(names)
    class_values = [str(v).lower() for v in names.values()]
    face_like = {"face", "rostro", "cara", "faces", "rostros"}

    if task != "detect":
        print(f"El modelo resuelve '{task}', no detección de cajas.")
        verdict = "OTRO"
    elif n_classes == 1 and class_values[0] in face_like:
        print("→ El modelo tiene UNA sola clase de tipo rostro.")
        print("→ Es un DETECTOR de rostros: dice DÓNDE hay una cara,")
        print("  pero NO dice DE QUIÉN es.")
        print("→ Para identificar personas hace falta un modelo de")
        print("  embeddings encima (ArcFace). Es la arquitectura de este proyecto.")
        verdict = "DETECTOR"
    elif n_classes > 1 and all(c in face_like for c in class_values):
        print("→ Varias clases faciales: podría identificar personas.")
        verdict = "CLASIFICADOR"
    else:
        print(f"→ Las clases NO son faciales: {class_values}")
        print("→ Este modelo NO sirve para este proyecto.")
        verdict = "NO_FACIAL"

    has_keypoints = task == "pose"
    print(f"\n¿Entrega landmarks faciales? : {'SÍ' if has_keypoints else 'NO'}")
    if not has_keypoints:
        print("  (cabeza 'Detect' → solo cajas. La alineación previa a ArcFace")
        print("   se resuelve con el modelo de landmarks de InsightFace.)")

    separator("4. INFERENCIA DE PRUEBA")
    if image_path and image_path.exists():
        source = str(image_path)
        print(f"Imagen real: {source}")
    else:
        source = np.zeros((640, 640, 3), dtype=np.uint8)
        print("Sin imagen suministrada → usando lienzo negro 640x640.")
        print("(No se esperan detecciones; sirve para validar el formato de salida.)")

    results = model.predict(source=source, verbose=False, conf=0.25)
    r = results[0]

    print(f"\nTipo de resultado : {type(r).__name__}")
    print(f"Shape de entrada  : {r.orig_shape}")
    print(f"Atributos         : boxes={r.boxes is not None}, "
          f"keypoints={getattr(r, 'keypoints', None) is not None}, "
          f"masks={r.masks is not None}")

    n = len(r.boxes) if r.boxes is not None else 0
    print(f"\nRostros detectados: {n}")
    if n:
        print(f"\n{'#':<4}{'clase':<12}{'conf':<10}{'x1':<8}{'y1':<8}{'x2':<8}{'y2':<8}")
        print("-" * 58)
        for i, box in enumerate(r.boxes):
            cls = int(box.cls[0])
            conf = float(box.conf[0])
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            print(f"{i:<4}{names.get(cls, cls):<12}{conf:<10.4f}"
                  f"{x1:<8.1f}{y1:<8.1f}{x2:<8.1f}{y2:<8.1f}")
        confs = [float(b.conf[0]) for b in r.boxes]
        print(f"\nConfianza  min={min(confs):.4f}  max={max(confs):.4f}  "
              f"media={sum(confs)/len(confs):.4f}")

    separator("5. FORMATO DE SALIDA ESPERADO POR EL PIPELINE")
    print("El detector devuelve, por cada rostro:")
    print("  bbox  : (x1, y1, x2, y2) en píxeles de la imagen ORIGINAL")
    print("  conf  : float 0..1")
    print("  cls   : índice de clase (siempre 0 con este modelo)")

    separator("VEREDICTO")
    print(f"  {verdict}")
    if verdict == "DETECTOR":
        print("  Compatible con la arquitectura: rostros.pt detecta,")
        print("  ArcFace identifica. ✓")
        return 0
    print("  Revisar antes de continuar.")
    return 0 if verdict == "CLASIFICADOR" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspecciona rostros.pt sin modificarlo")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--image", type=Path, default=None)
    a = parser.parse_args()
    return inspect(a.model, a.image)


if __name__ == "__main__":
    sys.exit(main())
