import cv2, insightface, numpy as np, io
from fastapi.testclient import TestClient
from app.main import app

img = insightface.data.get_image('t1')
ok, buf = cv2.imencode('.jpg', img)
payload = buf.tobytes()
print(f'imagen de prueba: {img.shape}, jpeg {len(payload)/1024:.0f} KB')

with TestClient(app) as client:
    r = client.get('/api/v1/health'); print('\nHEALTH', r.status_code, r.json())

    r = client.post('/api/v1/faces/detect', files={'file': ('f.jpg', payload, 'image/jpeg')})
    d = r.json()
    print(f"\nDETECT  status={r.status_code}  rostros={len(d['faces'])}  {d['processingTimeMs']} ms")
    for f in d['faces'][:8]:
        print('   ', f['bbox'], 'score', f['detectionScore'])

    r = client.post('/api/v1/faces/analyze', files={'file': ('f.jpg', payload, 'image/jpeg')})
    a = r.json()
    print(f"\nANALYZE status={r.status_code}  rostros={len(a['faces'])}  {a['processingTimeMs']} ms")
    print('   modelInfo:', a['modelInfo'])
    embs=[]
    for f in a['faces']:
        e = np.array(f['embedding'])
        embs.append(e)
        print(f"    bbox={f['bbox']} score={f['detectionScore']} dim={len(e)} |L2|={np.linalg.norm(e):.4f} blur={f['quality']['blurScore']}")
    if len(embs) > 1:
        M = np.array(embs) @ np.array(embs).T
        off = M[~np.eye(len(embs),dtype=bool)]
        print(f'\n   similitud entre rostros distintos: min={off.min():.3f} max={off.max():.3f}')

    # validaciones de seguridad
    r = client.post('/api/v1/faces/analyze', files={'file': ('x.txt', b'no soy imagen', 'text/plain')})
    print('\nSEGURIDAD tipo invalido ->', r.status_code, r.json().get('code'))
    r = client.post('/api/v1/faces/analyze', files={'file': ('x.jpg', b'basura', 'image/jpeg')})
    print('SEGURIDAD jpeg corrupto ->', r.status_code, r.json().get('code'))
