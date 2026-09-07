# ADR 0002 — rostros.pt como detector + ArcFace para identificar

**Estado:** aceptada · 2026-09-07

## Contexto

El proyecto parte de un modelo propio, `rostros.pt`. Antes de diseñar
nada había que determinar qué hace realmente.

## Qué se comprobó

Se inspeccionó el modelo sin cargarlo (extrayendo el `data.pkl` del
archivo y desensamblándolo con `pickletools`, sin ejecutar el pickle) y
después ejecutándolo con `scripts/inspect_model.py`:

```
task   : detect
nc     : 1
names  : {0: 'rostro'}
cabeza : Detect  (no Pose → sin landmarks)
base   : yolov8s.pt · dataset Rostros-1 · 40 epochs · imgsz 640
```

**Conclusión: es un detector puro.** Dice dónde hay una cara, no de
quién es.

> Nota histórica: el primer archivo entregado con ese nombre resultó ser
> un detector de tráfico (`bus, car, ciclist, motorcycle, pedestrian,
> truck`) entrenado con el dataset `traffic_medellin-1`. Se detectó
> precisamente por hacer esta verificación en lugar de asumir. El modelo
> se sustituyó después por el correcto.

## Decisión

Pipeline de dos modelos:

1. **`rostros.pt`** → cajas delimitadoras.
2. **InsightFace `2d106det`** → landmarks, para alinear.
3. **InsightFace ArcFace `w600k_r50`** → embedding de 512-d.

## Por qué ArcFace

| | ArcFace R50 | FaceNet | DeepFace |
|---|---|---|---|
| Separación entre identidades | Muy alta (margen angular) | Media | Variable |
| Runtime | ONNX, sin PyTorch | Requiere PyTorch | Requiere TensorFlow |
| Detector y landmarks de la misma familia | Sí | No | Mezcla |

Medido sobre las imágenes de prueba de InsightFace: misma persona ~0.99,
personas distintas −0.08 a 0.21.

## Por qué hace falta el paso de landmarks

ArcFace fue entrenado con recortes de 112×112 alineados por 5 puntos.
Como `rostros.pt` tiene cabeza `Detect`, no los entrega, y un recorte sin
alinear degrada la precisión.

Los índices para reducir 106 → 5 puntos (`[33, 96, 86, 65, 61]`) se
derivaron **empíricamente**: se comparó cada punto nativo de SCRFD con
el landmark más cercano de los 106, y se validó midiendo los embeddings
resultantes.

Validación sobre 6 rostros:

| Métrica | Resultado |
|---|---|
| Error de posición | 2.4 – 3.7 px |
| Similitud vs. alineación nativa | 0.977 – 0.997 |

## Detector intercambiable

`FaceDetector` es una interfaz con dos implementaciones: `yolo`
(rostros.pt, por defecto) y `scrfd` (InsightFace). Se cambia con
`FACE_DETECTOR_BACKEND`. Sustituir el modelo por una versión mejorada no
requiere tocar el pipeline.

## Limitación medida

`rostros.pt` no detecta rostros que queden por debajo de ~60 px tras el
reescalado a `imgsz`. Con `imgsz=640` falla en fotos de grupo lejanas y
acierta con rostros cercanos (conf 0.86), que es el caso de uso real.
Configurable con `YOLO_IMAGE_SIZE`.
