"""Caracteriza rostros.pt: a que tamano de rostro deja de detectar.

Hallazgo (ver docs/adr/0002): con imgsz=640 los rostros por debajo de
~60px en la imagen reescalada no se detectan. En control de acceso el
rostro esta cerca de la camara, asi que 640 es suficiente y mas rapido.
Para escenas amplias (varias personas lejanas) subir YOLO_IMAGE_SIZE.
"""
import cv2, insightface, numpy as np, os
from ultralytics import YOLO
from insightface import model_zoo

img = insightface.data.get_image('t1')
h,w = img.shape[:2]
print(f'imagen {w}x{h}')

d = os.path.expanduser('~/.insightface/models/buffalo_l')
det = model_zoo.get_model(os.path.join(d,'det_10g.onnx'), providers=['CPUExecutionProvider'])
det.prepare(ctx_id=-1, input_size=(640,640))
bb,_ = det.detect(img, max_num=0, metric='default')
print(f'\nSCRFD: {len(bb)} rostros. Tamanos:')
for b in bb: print(f'   {int(b[2]-b[0])}x{int(b[3]-b[1])} px  score {b[4]:.2f}')

m = YOLO('../../modelos/rostros.pt')
print('\nrostros.pt a distintos umbrales:')
for conf in (0.45, 0.25, 0.10, 0.05, 0.01):
    r = m.predict(source=img, conf=conf, imgsz=640, verbose=False)[0]
    n = len(r.boxes) if r.boxes is not None else 0
    top = f"{float(r.boxes.conf.max()):.3f}" if n else "-"
    print(f'   conf>={conf:<5} -> {n:2} detecciones  (max conf {top})')

print('\nrostros.pt a mayor resolucion de entrada:')
for sz in (640, 960, 1280):
    r = m.predict(source=img, conf=0.10, imgsz=sz, verbose=False)[0]
    n = len(r.boxes) if r.boxes is not None else 0
    top = f"{float(r.boxes.conf.max()):.3f}" if n else "-"
    print(f'   imgsz={sz:<5} -> {n:2} detecciones  (max conf {top})')

# Prueba sobre un rostro RECORTADO y grande (caso real de webcam: cara cercana)
print('\nPrueba con rostro grande (caso webcam real):')
x1,y1,x2,y2 = [int(v) for v in bb[0][:4]]
pad = int((x2-x1)*1.2)
crop = img[max(0,y1-pad):min(h,y2+pad), max(0,x1-pad):min(w,x2+pad)]
big = cv2.resize(crop, (640, int(640*crop.shape[0]/crop.shape[1])))
print(f'   recorte reescalado a {big.shape[1]}x{big.shape[0]}')
for conf in (0.45, 0.25, 0.10):
    r = m.predict(source=big, conf=conf, imgsz=640, verbose=False)[0]
    n = len(r.boxes) if r.boxes is not None else 0
    top = f"{float(r.boxes.conf.max()):.3f}" if n else "-"
    print(f'   conf>={conf:<5} -> {n:2} detecciones  (max conf {top})')
