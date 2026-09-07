"""
Valida el pipeline COMPLETO con rostros.pt como detector.

Simula el caso real de webcam: rostros cercanos, grandes en el encuadre.
Comprueba que dos capturas de la MISMA persona producen embeddings
parecidos, y que dos personas DISTINTAS producen embeddings lejanos.

Es la prueba que justifica el umbral de RECOGNITION_THRESHOLD.
"""
import cv2, insightface, numpy as np, os
from fastapi.testclient import TestClient
from app.main import app
from insightface import model_zoo

# Se usa SCRFD solo para recortar caras de la foto de grupo y fabricar
# los "primeros planos" de prueba. El pipeline bajo prueba usa rostros.pt.
img = insightface.data.get_image('t1')
h, w = img.shape[:2]
d = os.path.expanduser('~/.insightface/models/buffalo_l')
det = model_zoo.get_model(os.path.join(d, 'det_10g.onnx'), providers=['CPUExecutionProvider'])
det.prepare(ctx_id=-1, input_size=(640, 640))
bb, _ = det.detect(img, max_num=0, metric='default')

def closeup(i, scale, quality):
    """Recorta la cara i y la reescala como si fuera un primer plano."""
    x1, y1, x2, y2 = [int(v) for v in bb[i][:4]]
    pad = int((x2 - x1) * 1.1)
    crop = img[max(0, y1-pad):min(h, y2+pad), max(0, x1-pad):min(w, x2+pad)]
    out = cv2.resize(crop, (scale, int(scale * crop.shape[0] / crop.shape[1])))
    ok, buf = cv2.imencode('.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()

def embed(client, payload):
    r = client.post('/api/v1/faces/analyze',
                    files={'file': ('f.jpg', payload, 'image/jpeg')})
    data = r.json()
    if not data['faces']:
        return None, data
    return np.array(data['faces'][0]['embedding']), data

with TestClient(app) as client:
    print('=== DETECCION CON rostros.pt (primeros planos) ===')
    vectors = {}
    for i in range(len(bb)):
        e, data = embed(client, closeup(i, 640, 90))
        status = 'OK' if e is not None else 'NO DETECTADO'
        score = data['faces'][0]['detectionScore'] if data['faces'] else 0
        print(f'  persona {i}: {status:14} conf={score:.3f}  {data["processingTimeMs"]:.0f} ms')
        if e is not None:
            vectors[i] = e

    print(f'\n  detectadas {len(vectors)} de {len(bb)} caras')

    print('\n=== MISMA PERSONA (distinta escala y compresion JPEG) ===')
    same = []
    for i in list(vectors)[:4]:
        e2, _ = embed(client, closeup(i, 480, 65))
        if e2 is not None:
            s = float(vectors[i] @ e2)
            same.append(s)
            print(f'  persona {i}: similitud {s:.4f}')

    print('\n=== PERSONAS DISTINTAS ===')
    ids = list(vectors)
    diff = []
    for a in range(len(ids)):
        for b in range(a+1, len(ids)):
            s = float(vectors[ids[a]] @ vectors[ids[b]])
            diff.append(s)
    print(f'  {len(diff)} pares  min={min(diff):.4f}  max={max(diff):.4f}  media={np.mean(diff):.4f}')

    print('\n=== VEREDICTO SOBRE EL UMBRAL ===')
    UMBRAL = 0.38
    print(f'  RECOGNITION_THRESHOLD = {UMBRAL}')
    print(f'  misma persona    min = {min(same):.4f}   -> {"ACEPTA" if min(same) >= UMBRAL else "FALLA"}')
    print(f'  distinta persona max = {max(diff):.4f}   -> {"RECHAZA" if max(diff) < UMBRAL else "FALLA"}')
    margen = min(same) - max(diff)
    print(f'  separacion entre ambas nubes: {margen:.4f}')
    ok = min(same) >= UMBRAL and max(diff) < UMBRAL
    print(f'\n  {"PIPELINE CORRECTO" if ok else "REVISAR UMBRAL"}')
