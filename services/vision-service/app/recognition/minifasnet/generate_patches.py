# -*- coding: utf-8 -*-
# ══════════════════════════════════════════════════════════════════
#  ARCHIVO DE TERCEROS — copiado tal cual, NO se modifica.
#
#  Origen   : https://github.com/minivision-ai/Silent-Face-Anti-Spoofing
#             src/generate_patches.py
#  Autoria  : zhuying — Minivision Technology
#  Licencia : Apache-2.0, copia completa en modelos/antispoof/LICENSE
#
#  QUE HACE, Y POR QUE HACE FALTA TAL CUAL
#  ───────────────────────────────────────
#  Recorta el rostro con un margen alrededor. Ese margen NO es estetico:
#  cada uno de los dos modelos se entreno con su propia escala -2.7 y
#  4.0- y espera ver exactamente esa cantidad de contexto. Recortar mas
#  ajustado o mas holgado le cambia la entrada respecto a lo que vio
#  entrenando, y el numero que devuelve deja de significar lo mismo.
#
#  Por eso se copia en vez de reescribirlo con cv2 en cuatro lineas: el
#  ajuste de la caja a los bordes de la imagen es parte del contrato con
#  los pesos, no un detalle de implementacion.
#
#  Se mantiene sin tocar por el mismo motivo que MiniFASNet.py: poder
#  compararlo contra el original de un vistazo.
# ══════════════════════════════════════════════════════════════════
# @Time : 20-6-9 下午3:06
# @Author : zhuying
# @Company : Minivision
# @File : test.py
# @Software : PyCharm
"""
Create patch from original input image by using bbox coordinate
"""

import cv2
import numpy as np


class CropImage:
    @staticmethod
    def _get_new_box(src_w, src_h, bbox, scale):
        x = bbox[0]
        y = bbox[1]
        box_w = bbox[2]
        box_h = bbox[3]

        scale = min((src_h-1)/box_h, min((src_w-1)/box_w, scale))

        new_width = box_w * scale
        new_height = box_h * scale
        center_x, center_y = box_w/2+x, box_h/2+y

        left_top_x = center_x-new_width/2
        left_top_y = center_y-new_height/2
        right_bottom_x = center_x+new_width/2
        right_bottom_y = center_y+new_height/2

        if left_top_x < 0:
            right_bottom_x -= left_top_x
            left_top_x = 0

        if left_top_y < 0:
            right_bottom_y -= left_top_y
            left_top_y = 0

        if right_bottom_x > src_w-1:
            left_top_x -= right_bottom_x-src_w+1
            right_bottom_x = src_w-1

        if right_bottom_y > src_h-1:
            left_top_y -= right_bottom_y-src_h+1
            right_bottom_y = src_h-1

        return int(left_top_x), int(left_top_y),\
               int(right_bottom_x), int(right_bottom_y)

    def crop(self, org_img, bbox, scale, out_w, out_h, crop=True):

        if not crop:
            dst_img = cv2.resize(org_img, (out_w, out_h))
        else:
            src_h, src_w, _ = np.shape(org_img)
            left_top_x, left_top_y, \
                right_bottom_x, right_bottom_y = self._get_new_box(src_w, src_h, bbox, scale)

            img = org_img[left_top_y: right_bottom_y+1,
                          left_top_x: right_bottom_x+1]
            dst_img = cv2.resize(img, (out_w, out_h))
        return dst_img
