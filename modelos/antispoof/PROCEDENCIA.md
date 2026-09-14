# Modelos de detección de vida — de dónde salen

Estos dos archivos **no son de este proyecto**. Vienen de
[minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing),
bajo **licencia Apache 2.0** (copia en `LICENSE`).

| archivo | sha256 |
|---|---|
| `2.7_80x80_MiniFASNetV2.pth` | `a5eb02e1843f19b5386b953cc4c9f011c3f985d0ee2bb9819eea9a142099bec0` |
| `4_0_0_80x80_MiniFASNetV1SE.pth` | `84ee1d37d96894d5e82de5a57df044ef80a58be2b218b5ed7cdfd875ec2f5990` |

Descargados el 2026-09-14 de
`raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/master/resources/anti_spoof_models/`.

## Y el codigo que los interpreta

Un `.pth` sin la clase que lo carga no es nada, asi que la arquitectura
viaja con los pesos. Esta en
`services/vision-service/app/recognition/minifasnet/`, copiada del mismo
repositorio y bajo la misma licencia:

| archivo | origen |
|---|---|
| `MiniFASNet.py` | `src/model_lib/MiniFASNet.py` |
| `generate_patches.py` | `src/generate_patches.py` |

**Los dos llevan una cabecera de atribucion anadida, y nada mas.** El
cuerpo esta sin tocar a proposito: ni formato, ni nombres, ni type
hints. Poder compararlo contra el original de un vistazo es lo unico que
permite auditar que lo que corre aqui es lo que se descargo, y un
arreglo de estilo destruiria esa posibilidad a cambio de nada.

Checksums del archivo **tal como se descargo**, es decir del actual
quitandole la cabecera:

| archivo | lineas de cabecera | sha256 del original |
|---|---|---|
| `MiniFASNet.py` | 27 (2-28) | `e498c4ec5e1ddfaba62b941a126c19d65aa564999f3309661fe43ee8bf38acd7` |
| `generate_patches.py` | 23 (2-24) | `cd33552d5ca920088143daafceba3c19b7a64bf9aac125241803e1b4af698d65` |

Para comprobarlo, desde la raiz del repositorio:

    cd services/vision-service/app/recognition/minifasnet
    { head -1 MiniFASNet.py; tail -n +29 MiniFASNet.py; } | sha256sum
    { head -1 generate_patches.py; tail -n +25 generate_patches.py; } | sha256sum

La linea 1 es el `# -*- coding: utf-8 -*-`, que va antes de la cabecera
porque tiene que seguir siendo la primera del archivo.

El codigo propio de este proyecto -el que decide como se recorta, como
se normaliza y que significa cada salida- esta en
`app/recognition/spoof.py`, fuera de esa carpeta.

## Por qué están versionados aquí y no se descargan al construir

Mismo criterio que `rostros.pt`: **son parte del camino crítico de
seguridad**, y lo que decide si una puerta se abre no puede depender de
que un tercero siga sirviendo un archivo, ni cambiar de contenido sin
que nadie se entere. Con el checksum arriba, cualquiera puede comprobar
que lo que corre es lo que se auditó.

Los pesos de InsightFace sí se bajan en la construcción, y la diferencia
es deliberada: aquellos producen un vector que después se compara contra
un umbral propio; estos emiten un veredicto.

## La advertencia que más cara cuesta

**Estos modelos esperan la entrada en 0–255, NO en [0, 1].**

El repositorio original trae su propio `to_tensor` con el `.div(255)`
comentado, y las estadísticas de BatchNorm lo confirman: la primera capa
tiene `running_mean` de −49 y `running_var` de 958.

Alimentados en `[0, 1]` **no fallan de forma visible**: responden
exactamente lo mismo a una cara, a ruido puro y a una imagen negra
—clase 2 al 99 %—. Parece un modelo que no generaliza cuando en realidad
no está viendo nada. Se perdió una tarde en eso; que no se pierda otra.

## Las tres salidas

`[0]` ataque impreso · `[1]` **cara real** · `[2]` ataque de pantalla.

No está documentado así en el repositorio de origen: se dedujo midiendo
sobre el conjunto de ataque de este proyecto, donde la clase 1 separa las
caras reales y la 2 las pantallas, las dos sin solapamiento.
