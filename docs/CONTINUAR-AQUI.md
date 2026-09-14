# Pegar esto en una pestaña nueva de Claude Code

---

Continúo un proyecto de control de acceso y asistencia por reconocimiento
facial en `C:\Users\ASUS\Desktop\backend_detector` (Windows, Docker
Compose, PowerShell). **Lee primero `docs/HANDOFF.md` y `README.md`**:
describen el sistema entero, las 14 ADRs y las limitaciones conocidas.

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
(voice-service, logbook-service, servidor MCP e interfaz) y la
**sustitución de la detección de vida ya terminada**.

**Todo está commiteado en local y NADA subido.** El árbol de trabajo
está limpio. Pregúntame antes de hacer push.

## Lo que se cerró en la última sesión

La primera limitación del README era que el sistema no es apto para
control de acceso real porque su detección de vida no estaba validada.
**Ya está medida y sustituida.**

- La señal espectral vieja (`detailRatio`, `patternPeak`) quedó
  refutada contra un ataque real y **ya no decide nada**. Se sigue
  midiendo y enviando solo para poder compararla.
- La decide **MiniFASNet**, vendorizado en `modelos/antispoof/` con sus
  checksums, sobre el **frame original** (no sobre el recorte de 112).
- El Vision Service devuelve `spoofScore`; el Access Service decide con
  `LIVENESS_MIN_SPOOF_SCORE=0.60`.

Medido sobre 40 caras reales y 38 fotos de esas caras en la pantalla de
un móvil, variante de 640 px, sin ajustar ningún umbral:

    cara real   0.9851 ± 0.0399   peor caso 0.7769
    pantalla    0.1187 ± 0.1517   mejor caso 0.5388
    APCER 0.0 %   BPCER 0.0 %     9.2 ms de mediana

Y el corte elegido usando **solo la primera tanda de captura**, aplicado
a las que no participaron en elegirlo, también da 0 % y 0 %.

Todo esto está en el
[ADR 0014](adr/0014-modelo-de-deteccion-de-vida.md). **No lo repitas.**

## Lo que falta: ampliar el conjunto de ataque

Es lo único que queda entre el estado actual y poder encender
`LIVENESS_MODE=HARD`. El conjunto de hoy es de **una persona y un
móvil**. Faltan, por orden de valor:

1. **Foto impresa** en papel, mate y satinado.
2. **Vídeo reproducido en una pantalla** (una cara que parpadea y se
   mueve, que es el ataque que una señal pasiva tiene más difícil).
3. **Más de una persona**, para que BPCER signifique algo.
4. Otra cámara y otra iluminación.

El flujo es el mismo de siempre, y las dos herramientas ya existen:

    node scripts/capture-attack-set.mjs   # graba, abre localhost:5174
    node scripts/measure-liveness.mjs     # mide y da el veredicto

El conjunto vive en `datasets/liveness/` y **no está en git a
propósito**: son rostros reales y el `.gitignore` excluye `/datasets/`
entero.

Con los datos nuevos, el medidor dirá si el umbral de 0.60 sigue
valiendo. **Solo entonces se plantea `HARD`, y por zona, no
globalmente.**

## Cosas que te van a morder

**1. No enciendas `HARD`.** Aunque los números de arriba sean buenos,
cubren un solo tipo de ataque. El defecto `SOFT` es lo que ha evitado
dos veces que un fallo dejara a alguien en la calle.

**2. El `/255`.** Los pesos de MiniFASNet esperan la entrada en 0–255,
no en `[0,1]`. Alimentados mal **no fallan de forma visible**: responden
lo mismo a una cara, a ruido puro y a una imagen negra. Está en
`modelos/antispoof/PROCEDENCIA.md`, y hay un test que lo caza
(`test_spoof.py::NoEstaCiego`), pero ese test **no corre en el CI**
porque necesita torch y los pesos: se ejecuta dentro del contenedor.

**3. Ausencia, nunca cero.** Cuando no se puede medir, `spoofScore`
viaja **ausente**. Un 0.0 significa «ataque segurísimo» y en `HARD`
dejaría a una persona real fuera por un error de código. Las dos mitades
de esa decisión —`spoof.py` y `judgeFrame`— tienen que seguir
coincidiendo.

**4. El umbral está atado al modelo.** La respuesta lleva
`modelInfo.spoofDetector` y `spoofDetectorVersion` justo para esto: si
cambian, la escala del número cambia y hay que volver a medir antes de
tocar `LIVENESS_MIN_SPOOF_SCORE`.

**5. Si faltan los pesos, el Vision Service no arranca.** Es
deliberado, y ya mordió una vez en la sesión anterior: sin la variable
`ANTISPOOF_MODELS_DIR` el contenedor entra en bucle de reinicio. Un
servicio que levantara sin medir la vida apagaría la protección en
silencio.

**6. El modelo no valida rostros.** Con ruido puro devuelve 0.97 de
«cara real». Da por hecho que hay una cara porque el detector ya la
encontró.

## Método que quiero que mantengas

Este proyecto mide antes de creerse nada, y **rompe sus propios tests a
propósito** para comprobar que fallan por el motivo que dicen cubrir. En
la última sesión eso encontró dos tests que no cubrían lo que decían: el
del fallo de medida salía por un guarda de entrada sin llegar nunca al
camino del error, y el del rango de la probabilidad usaba una imagen que
puntuaba tan bajo que ni sumando los dos modelos se salía de `[0, 1]`.
Los dos pasaban en verde.

Si sacas un número, di **con cuántas muestras** y **si el corte se
eligió sobre esos mismos datos**. El medidor ya parte el conjunto por
tanda de captura para responder esa segunda pregunta solo.

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
- Reconstruir el Vision Service vuelve a descargar los modelos de
  InsightFace (~280 MB), porque el `RUN` que los baja va después del
  `COPY app`. Son unos 30 s con red buena, pero no es instantáneo.
