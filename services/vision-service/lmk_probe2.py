import numpy as np, insightface, os
from insightface.app.common import Face
from insightface import model_zoo
from insightface.utils import face_align

d = os.path.expanduser('~/.insightface/models/buffalo_l')
img = insightface.data.get_image('t1')
det = model_zoo.get_model(os.path.join(d,'det_10g.onnx'), providers=['CPUExecutionProvider'])
det.prepare(ctx_id=-1, input_size=(640,640))
lmk = model_zoo.get_model(os.path.join(d,'2d106det.onnx'), providers=['CPUExecutionProvider'])
lmk.prepare(ctx_id=-1)
rec = model_zoo.get_model(os.path.join(d,'w600k_r50.onnx'), providers=['CPUExecutionProvider'])
rec.prepare(ctx_id=-1)

IDX = [33, 96, 86, 65, 61]
bboxes, kpss = det.detect(img, max_num=0, metric='default')
print(f'{"cara":<6}{"cos(kps_scrfd, kps_106)":<26}{"err_px_media":<14}')
print('-'*48)
sims, errs = [], []
for i in range(len(bboxes)):
    f = Face(bbox=bboxes[i][:4], det_score=bboxes[i][4], kps=kpss[i])
    lmk.get(img, f)
    l106 = f['landmark_2d_106']
    kps5 = np.array([l106[j] for j in IDX], dtype=np.float32)

    e_gt  = rec.get_feat(face_align.norm_crop(img, kpss[i], 112)).flatten()
    e_106 = rec.get_feat(face_align.norm_crop(img, kps5,     112)).flatten()
    e_gt  /= np.linalg.norm(e_gt); e_106 /= np.linalg.norm(e_106)
    cos = float(e_gt @ e_106)
    err = float(np.mean(np.linalg.norm(kpss[i]-kps5, axis=1)))
    sims.append(cos); errs.append(err)
    print(f'{i:<6}{cos:<26.5f}{err:<14.2f}')

print(f'\nsimilitud media: {np.mean(sims):.5f}  min: {np.min(sims):.5f}')
print(f'embedding dim: {e_gt.shape[0]}  norma L2: {np.linalg.norm(e_gt):.4f}')

# Sanidad: rostros DISTINTOS deben dar similitud baja
print('\n--- control: similitud entre personas distintas ---')
feats=[]
for i in range(len(bboxes)):
    e = rec.get_feat(face_align.norm_crop(img, kpss[i], 112)).flatten()
    feats.append(e/np.linalg.norm(e))
M = np.array(feats) @ np.array(feats).T
off = M[~np.eye(len(feats),dtype=bool)]
print(f'inter-persona  min={off.min():.4f}  max={off.max():.4f}  media={off.mean():.4f}')
print(f'misma persona (alineaciones distintas) media={np.mean(sims):.4f}')
