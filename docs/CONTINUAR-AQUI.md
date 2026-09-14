# Pegar esto en una pestaña nueva de Claude Code

---

Continúo un proyecto de control de acceso y asistencia por reconocimiento
facial en `C:\Users\ASUS\Desktop\backend_detector` (Windows, Docker
Compose, PowerShell). **Lee primero `docs/HANDOFF.md` y `README.md`**:
describen el sistema entero, las 13 ADRs y las limitaciones conocidas.

Este documento cuenta solo **lo que está a medias ahora mismo**.

## Reglas de trabajo (no negociables)

1. Nunca `git push` sin preguntarme antes.
2. Rama de feature con nombre **en inglés**; yo abro el PR y hago el merge.
3. **Sin atribución a Claude** en los commits: nada de `Co-Authored-By`
   ni firmas equivalentes.
4. Commits y documentación **en español**; nombres de rama en inglés.
5. **Verifica contra el stack levantado**, no solo que compile.
   `docker compose up -d` · `node scripts/ci-local.mjs --rapido`

Estoy en PowerShell: no me des sintaxis de bash (`{1..10}`, `rm -rf`).

## Dónde está el repositorio

Rama `feature/liveness-attack-capture`, con la Fase 5 completa
(voice-service, logbook-service, servidor MCP e interfaz) ya subida.

**Todo está commiteado en local y NADA subido**: los dos últimos commits
son «Anade el medidor de la deteccion de vida» y «Vendoriza MiniFASNet».
El árbol de trabajo está limpio. Pregúntame antes de hacer push.

## Lo que estábamos haciendo: sustituir la detección de vida

El README dice, como limitación número uno, que el sistema **no es apto
para control de acceso real** porque su detección de vida no está
validada. Eso es lo que estamos cerrando.

### Lo que ya está medido (esto es el trabajo hecho, no lo repitas)

Hay un conjunto de ataque **real** en `datasets/liveness/` —40 caras
reales y 40 fotos en la pantalla de un móvil, misma webcam, dos sesiones,
dos variantes por disparo (`terminal` 640 px y `nativo` 1280 px)—. No
está en git a propósito: son rostros reales y el `.gitignore` excluye
`/datasets/` entero.

Herramientas, las dos ya commiteadas:

    node scripts/capture-attack-set.mjs   # graba
    node scripts/measure-liveness.mjs     # responde si una señal separa

**La señal vieja (pico periódico) NO sirve, y ahora está demostrado.**
Con la sesión 1 sola parecía separar perfecto y el mejor corte daba 0 % de
error. Aplicado a la sesión 2, que no participó en elegirlo: **BPCER 20 %
y APCER 25 %**. Una de cada cinco personas fuera del edificio y uno de
cada cuatro ataques dentro. Se solapan: caras reales hasta 29,02 y
ataques desde 21,52. Parte del problema es que el pico correlaciona
**+0,39 con el ancho de la cara**: mide, en buena medida, a qué distancia
estás de la cámara.

**MiniFASNet SÍ sirve**, evaluado sobre esas mismas 80 imágenes:

| | |
|---|---|
| BPCER | **0,0 %** — 40/40 caras reales aceptadas |
| APCER | **2,6 %** — 37/38 ataques rechazados |
| Margen | peor cara real 0,777 · mejor ataque 0,539 |
| Latencia | **22,7 ms** (el detector cuesta 740) |

Sin ajustar ni un umbral: el modelo nunca vio estas fotos y se usó su
decisión nativa (`argmax`). Aguanta en las dos sesiones por separado.

### Dónde me quedé exactamente

Acababa de **vendorizar** los pesos y el código:

- `modelos/antispoof/` — los dos `.pth` (3,6 MB), el `LICENSE`
  Apache-2.0 del repositorio de origen, y `PROCEDENCIA.md` con los
  checksums y las advertencias.
- `services/vision-service/app/recognition/minifasnet/` — `MiniFASNet.py`
  y `generate_patches.py` copiados tal cual de
  [minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing)
  (Apache-2.0, 1.814 estrellas). **Falta ponerles cabecera de atribución.**

## Lo que falta, en orden

1. **Cabecera de atribución** en los dos archivos vendorizados.
2. **`app/recognition/spoof.py`**: carga los dos modelos una vez al
   arrancar (como ArcFace) y puntúa un rostro. Recorte con
   `CropImage.crop(imagen, bbox, escala, 80, 80, True)` a escalas 2.7 y
   4.0, softmax de cada modelo, suma, y `prob[1]` = probabilidad de cara
   real.
3. **`face_pipeline.py`**: añadir la puntuación junto a las dos señales
   viejas, sin quitarlas todavía. Span propio `vision.spoof`.
4. **Esquemas**: `vision.py`, el cliente del Face Service y el del
   Access Service.
5. **Access Service**: `liveness.engine.ts` decide con la puntuación
   nueva (`minSpoofScore`), manteniendo `OFF`/`SOFT`/`HARD`. **El defecto
   sigue siendo `SOFT`.**
6. **Variables** en `.env.example` y `docker-compose.yml`.
7. **ADR 0014** con los números de arriba, y actualizar el ADR 0010, el
   README y el HANDOFF: hoy dicen que la señal no funciona y por qué,
   y hay que contar que ya está medido y sustituido.
8. Tests, y verificar contra el stack levantado.

## Tres cosas que te van a morder

**1. El `/255`.** Estos modelos esperan la entrada en **0–255**, no en
`[0,1]`. El repositorio original trae su propio `to_tensor` con el
`.div(255)` comentado. Alimentados mal **no fallan de forma visible**:
responden lo mismo a una cara, a ruido puro y a una imagen negra. Parece
un modelo que no generaliza cuando en realidad no ve nada. Está escrito
en `modelos/antispoof/PROCEDENCIA.md`.

**2. Las clases.** `[0]` impreso · `[1]` **cara real** · `[2]` pantalla.
No está documentado en el origen: se dedujo midiendo.

**3. No enciendas `HARD`.** Falta foto impresa, vídeo en pantalla y más
de una persona. El defecto `SOFT` es lo único que ha evitado que esto
deje a nadie en la calle, y ya hubo un susto: con la sesión 1 sola, la
señal vieja parecía perfecta.

## Método que quiero que mantengas

Este proyecto mide antes de creerse nada, y **rompe sus propios tests a
propósito** para comprobar que fallan por el motivo que dicen cubrir. Dos
veces en esta sesión eso evitó un error serio: un medidor que declaraba
«la señal separa» habiendo medido cero caras, y un umbral que parecía
perfecto y habría dejado fuera a una de cada cinco personas.

Si sacas un número, di con cuántas muestras y si el corte se eligió sobre
esos mismos datos.

## Entorno, para que no pierdas tiempo

- **Kaspersky intercepta el TLS** a `api.deepgram.com`: 7 de cada 8
  certificados venían firmados por «AO Kaspersky Lab». Hay que excluir
  ese dominio del análisis de conexiones cifradas.
- El DNS de la red no resuelve ese mismo dominio. Hay una superposición
  opcional: `docker compose -f docker-compose.yml -f docker-compose.dns.yml up -d`
- Gemini: plan gratuito, **20 peticiones al día por modelo**. Las cuotas
  son por modelo, así que cambiar `GEMINI_MODEL` da otras 20.
- `docker compose cp` escribe como root y los servicios corren sin
  privilegios: para borrar dentro de un contenedor hace falta
  `docker compose exec -u root`.
- En Git Bash, las rutas de contenedor se mutilan: usa
  `MSYS_NO_PATHCONV=1` delante de `docker compose exec` y `cp`.
