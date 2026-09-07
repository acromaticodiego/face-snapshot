import numpy as np, insightface, os
from insightface.app.common import Face
from insightface import model_zoo

d = os.path.expanduser('~/.insightface/models/buffalo_l')
img = insightface.data.get_image('t1')
print('imagen de prueba:', img.shape)

det = model_zoo.get_model(os.path.join(d,'det_10g.onnx'), providers=['CPUExecutionProvider'])
det.prepare(ctx_id=-1, input_size=(640,640))
bboxes, kpss = det.detect(img, max_num=0, metric='default')
print('rostros detectados por SCRFD:', len(bboxes))
print('kps shape:', None if kpss is None else kpss.shape)

lmk = model_zoo.get_model(os.path.join(d,'2d106det.onnx'), providers=['CPUExecutionProvider'])
lmk.prepare(ctx_id=-1)
print('landmark taskname:', getattr(lmk,'taskname',None))

f = Face(bbox=bboxes[0][:4], det_score=bboxes[0][4], kps=kpss[0])
lmk.get(img, f)
l106 = f['landmark_2d_106']
print('106 landmarks shape:', l106.shape)

gt = kpss[0]  # ground truth 5 pts de SCRFD
print('\nGT 5 puntos (SCRFD):'); print(np.round(gt,1))

# Para cada punto GT, buscar el indice del landmark 106 mas cercano
print('\nindice 106 mas cercano a cada punto GT:')
labels = ['ojo_izq','ojo_der','nariz','boca_izq','boca_der']
best = []
for i,g in enumerate(gt):
    dists = np.linalg.norm(l106 - g, axis=1)
    j = int(np.argmin(dists))
    best.append(j)
    print(f'  {labels[i]:9} -> idx {j:3}  dist {dists[j]:.2f}px')
print('\nindices sugeridos:', best)
