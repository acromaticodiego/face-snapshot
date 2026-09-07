# ADR 0003 — Umbral de similitud y votación multi-frame

**Estado:** aceptada · 2026-09-07

## Contexto

Hay que decidir cuándo dos embeddings corresponden a la misma persona, y
cuántas veces confirmarlo antes de abrir la puerta.

## Decisión

- **Umbral:** similitud coseno ≥ `0.38` (`RECOGNITION_THRESHOLD`).
- **Votación:** 3 coincidencias de la misma persona en una ventana
  deslizante de 5 frames.

## Sobre el umbral

Los embeddings salen normalizados L2, así que el producto escalar es
directamente la similitud coseno.

Medición sobre el **pipeline completo** (rostros.pt → landmarks →
ArcFace), con 6 rostros de las imágenes de prueba de InsightFace
recortados como primeros planos, y comparando cada uno consigo mismo a
menor resolución y con más compresión JPEG
(`tests/test_recognition_quality.py`):

```
misma persona      0.4923 .. 0.9946
personas distintas -0.0825 .. 0.2371   (15 pares, media 0.02)

separación entre ambas nubes: 0.2552
```

`0.38` cae entre las dos nubes, que es lo que debe hacer un umbral.

**Importante — el margen no es tan holgado como parece.** Un primer test
con capturas de buena calidad daba 0.99 frente a 0.21. Al añadir un caso
degradado (el rostro con menor confianza de detección, reescalado a 480
px y comprimido al 65 %) la similitud consigo mismo cayó a **0.4923**.
Es decir: el peor caso legítimo queda solo 0.11 por encima del umbral.

Consecuencia práctica: **la calidad de la captura importa tanto como el
umbral.** Por eso el filtro de calidad descarta rostros pequeños,
borrosos o cortados antes de generar el embedding.

> **Pendiente:** recalibrar con los rostros y la cámara reales del
> despliegue. Seis caras de una foto de archivo no representan las
> condiciones de iluminación de un vestíbulo.

## Sobre la votación

Conceder acceso con un único frame es el fallo más común de estos
sistemas: un reflejo o un encuadre afortunado pueden producir una
coincidencia puntual. Exigir 3 de 5 reduce drásticamente los falsos
positivos a cambio de aproximadamente un segundo de espera a 5 fps.

Un frame sin coincidencia también se registra en la ventana, de modo que
alternar entre una persona registrada y una desconocida impide acumular
votos: solo una racha consistente concede el acceso.

## Dónde vive

En el **Access Service**, no en el Gateway ni en el frontend. Es el punto
donde se enchufará la detección de vida, porque ya acumula frames
consecutivos, que es justo lo que necesita un verificador temporal.

## Consecuencia

El estado de las ventanas está en memoria del proceso. Con varias
réplicas del Access Service haría falta Redis o afinidad de sesión.
Aceptable mientras haya una sola instancia.
