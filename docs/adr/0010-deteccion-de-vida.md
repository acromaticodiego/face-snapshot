# ADR 0010 — Detección de vida pasiva, y por qué no deniega por defecto

**Estado:** aceptada · 2026-09-13 · **la señal elegida quedó refutada**
el 2026-09-13, ver «Actualización» al final

> **Lee primero la actualización del final.** La decisión de estructura
> —medir en el Vision Service, decidir en el Access Service, tres modos,
> y no denegar por defecto— sigue en pie y demostrada. La **señal**
> concreta que este ADR eligió, no: se midió contra un ataque real y
> apunta al revés.

## Contexto

El README ha dicho desde el principio que el sistema **no es apto para
producción real** por una razón concreta: una foto en un móvil pasa la
autenticación. Es la primera pregunta que hace cualquiera ante un
control de acceso facial, y no tenía respuesta.

## La restricción que condiciona todo lo demás

**No hay con qué validar esto.** Un detector de ataques de presentación
se demuestra con un conjunto de ataques reales —fotos impresas en papel
mate y satinado, pantallas de distintas densidades, máscaras— y midiendo
APCER y BPCER según la ISO/IEC 30107-3. Este proyecto no tiene ese
conjunto, y sin él **cualquier afirmación sobre lo que detecta sería
inventada**.

Esa restricción no es un detalle de implementación: decide el diseño.

## Decisión

Una detección de vida **pasiva y heurística**, que mide y no juzga en el
Vision Service, y que **por defecto NO deniega**.

### Dónde vive cada parte

| | Dónde | Qué hace |
|---|---|---|
| Medida | `vision-service` | Devuelve dos números sobre la textura del rostro |
| Política | `access-service` | Decide qué significan y qué hacer |

Es el mismo reparto que con el umbral de similitud ([ADR 0003](0003-umbral-y-votacion.md))
y con el anti-passback. El Vision Service no conoce identidades ni
políticas, y **un umbral de seguridad es política**.

### Las dos señales, y por qué son dos

Una cara real capturada por la cámara y una **foto de esa cara** vuelta
a fotografiar no tienen el mismo espectro de frecuencias:

- Una **reimpresión** atraviesa dos veces un proceso de captura y
  compresión. Cada pasada recorta detalle fino, así que el resultado es
  más pobre en altas frecuencias aunque parezca nítido.
- Una **pantalla** hace lo contrario: su rejilla de píxeles es un patrón
  periódico que aparece como picos aislados y fuertes en el espectro.

Apuntan en **direcciones opuestas**, y por eso se miden por separado en
vez de combinarse en una cifra: una sola métrica se anularía sola en el
caso de la pantalla, que baja una señal y sube la otra.

Medido sobre un rostro real al que se aplicaron las degradaciones a
propósito:

| caso | detalle fino | pico periódico |
|---|---|---|
| captura directa | 0.563 | 14 |
| foto de una foto | 0.320 | 38 |
| foto de una foto (q90) | 0.292 | 48 |
| pantalla | 0.627 | 149 |
| pantalla + recaptura | 0.504 | 571 |

El pico se busca **solo en la banda alta**, y eso también se midió: con
la banda útil entera, la estructura de la propia cara domina el máximo y
el número apenas separa una pantalla de una captura directa (137 frente
a 99). Restringido a la banda alta, la separación es de un orden de
magnitud (149 frente a 14).

> Estos números salen de **una** imagen y de degradaciones
> **fabricadas**. Dicen que las señales reaccionan, que es el mínimo
> para molestarse en calcularlas. No dicen nada sobre la separación
> frente a ataques reales.

### Tres modos, los mismos que el anti-passback

`OFF` / `SOFT` / `HARD`, con el mismo significado que ya tienen las
zonas con anti-passback: no mirar, mirar y anotar, o mirar y cerrar.
Reutilizar el vocabulario evita que quien opera el sistema aprenda dos
escalas para la misma idea.

**El defecto es `SOFT`.** Denegar el paso a una persona real apoyándose
en una señal que nadie ha calibrado es peor que el problema que intenta
resolver: alguien se queda en la calle por un número sin validar. En
`SOFT` la sospecha se anota en `acceso_sospechas_de_vida` y en el
registro, el acceso sigue su curso, y esa métrica es **la fuente con la
que calibrar** antes de encender `HARD`.

### De dónde sale la robustez ante un frame ruidoso

De la votación que ya existía, no de un mecanismo nuevo. El motor juzga
**un** frame; un frame sospechoso se deniega y **no acumula voto**,
exactamente igual que `LOW_QUALITY` o `MULTIPLE_FACES`. Como entrar
exige 3 coincidencias en una ventana de 5, un reflejo aislado no cierra
la puerta pero una fuente consistentemente sospechosa nunca llega a los
3 votos.

Se escribió primero un juez de ventana aparte, con su propio recuento de
mayorías, y **se retiró** al ver que duplicaba lo que la votación ya
hacía.

### Sin evidencia no hay sospecha

Si el Vision Service no envía medidas —una versión anterior a esta fase,
o un fallo midiendo— el frame se considera limpio. Tratar la ausencia
como sospecha convertiría un despliegue escalonado en una puerta cerrada
para todo el mundo: los servicios no se actualizan a la vez.

## Lo que costó, medido

| Etapa | p95 |
|---|---|
| `vision.detect` | ~563 ms |
| `vision.embed` | ~512 ms |
| **`vision.liveness`** | **~4.7 ms** |

Menos del 1 % del presupuesto de un frame. Esto no se estimó: sale de la
traza que la [Fase 4](0009-observabilidad-con-opentelemetry.md) instaló,
y es exactamente para lo que servía instalarla.

## Lo que se probó, y lo que no

**Probado contra el stack real:** que la evidencia viaja del Vision
Service a la decisión, que `HARD` deniega con `LIVENESS_FAILED`, y que
`SOFT` con la misma sospecha **deja pasar**. Se forzó un umbral
imposible para provocar la sospecha, porque es lo que demuestra el
cableado sin fingir nada sobre la precisión.

**No probado:** que detenga un ataque real. Se intentó con un ataque
sintético —una rejilla de píxeles sobre el rostro— y el intento produjo
un hallazgo propio: **el detector deja de encontrar la cara antes de que
la señal reaccione.** Con una modulación del 2 % la cara se detecta y la
señal no se inmuta; con un 5 % ya no hay cara que analizar. Un ataque de
pantalla realista no se puede fabricar degradando una imagen: hay que
fotografiar una pantalla de verdad.

**Consecuencia directa:** con los umbrales por defecto, el ataque
sintético más fuerte que el detector todavía tolera **no se detecta**.
Los umbrales son provisionales y están anotados como tales en el
`.env.example`.

## Lo que esto NO detecta

Un vídeo reproducido en una pantalla de buena calidad, una máscara, o
una foto impresa en papel mate de alta resolución. La lista no pretende
ser exhaustiva: sin un conjunto de ataques con el que medir, enumerar lo
que detecta y lo que no sería adivinar.

## Alternativas descartadas

**Un modelo entrenado (MiniFASNet y similares).** Es la vía de
producción, y se descartó por ahora: mete una dependencia externa de
procedencia incierta en el camino crítico de seguridad, cuesta latencia
sobre un presupuesto que la Fase 4 ya mostró ajustado —el detector se
lleva el 60-65 %— y **tampoco se podría validar** sin muestras de
ataque. Cuando haya con qué medir, es el siguiente paso.

**Reto activo (parpadear o girar la cabeza).** Sí se podría demostrar
que funciona, porque una foto estática nunca pasa el reto. Se descartó
porque cambia la experiencia: pasar por una puerta deja de ser
instantáneo, y eso es una decisión de producto, no técnica. Queda
anotada como la opción a recuperar si la vía pasiva no basta.

## Qué haría falta para encender `HARD`

En este orden:

1. Dejar `SOFT` corriendo con tráfico real y mirar
   `acceso_sospechas_de_vida` en Grafana. Si aparece tráfico constante
   sin que nadie ataque nada, los umbrales están mal y encender la
   denegación dejaría gente en la calle.
2. Reunir un conjunto de ataques reales, aunque sea pequeño: fotos
   impresas y pantallas, capturadas con la misma cámara del despliegue.
3. Medir APCER y BPCER con esos datos y fijar los umbrales con ellos.
4. Solo entonces, y por zona, no globalmente.


---

## Actualización · 2026-09-13 · la señal no funciona

Se midió con un ataque real —una cara y una foto de esa cara en la
pantalla de un móvil, misma webcam, seguidas— y **las dos entraron**.

| | detalle fino | pico periódico |
|---|---|---|
| Cara real (3 frames) | 0.382 – 0.443 | **24.8 – 43.6** |
| Móvil (4 frames) | 0.357 – 0.442 | **23.7 – 28.9** |

El `pattern_peak` existe para delatar la rejilla de una pantalla y marcó
**más alto con la cara real**. El `detail_ratio` no distingue nada.

### Por qué, y por qué no es un problema de umbral

El apartado «POR QUE SOBRE EL RECORTE ALINEADO» de este ADR era la
equivocación. Medir sobre el recorte de 112x112 normaliza la distancia a
la cámara, que era el objetivo, pero **destruye justo lo que se quería
medir**: entre el sensor y esa medida hay dos reducciones sin filtro
antialias —el terminal manda 640 px de ancho, y `norm_crop` remuestrea a
112 con un `warpAffine` bilineal—. Una rejilla de píxeles no sobrevive a
eso: se pierde, o se pliega por aliasing a una frecuencia arbitraria.

Lo que `pattern_peak` mide de hecho, siendo `max/mediana` de la banda
alta, es **si la banda alta tiene estructura destacada**. Una cara real
capturada de frente la tiene —pelo, bordes, textura de piel—; una foto
en una pantalla llega más suave, con la banda alta plana. De ahí el
signo invertido, que no es casualidad ni ruido.

La tabla de degradaciones sintéticas de más arriba reaccionaba porque la
rejilla se aplicaba **píxel a píxel sobre la imagen ya reducida**, que
es una cosa que no le pasa a ninguna fotografía de ninguna pantalla.

### Qué se conserva

Todo lo que no es la señal: la separación medida/política, los tres
modos, el defecto `SOFT` —que es lo único que ha evitado que este fallo
dejara gente en la calle—, que un frame sospechoso no acumule voto, y
los 4.7 ms. Sustituir la señal es cambiar `liveness.py` y los umbrales.

### Qué NO hacer

No invertir el umbral. Los rangos se solapan (24.8–43.6 frente a
23.7–28.9) y salen de siete frames de una sesión: elegir un corte ahí es
numerología, no medida.

### Consecuencia para las dos alternativas que quedan

Las dos siguen siendo las de este ADR —un modelo entrenado tipo
MiniFASNet, o el reto activo—, con una condición nueva que se aplica a
cualquier vía pasiva: **la señal no puede medirse sobre el recorte de
112**, y probablemente tampoco sobre el frame de 640 que el terminal
envía hoy. Eso convierte «cambiar `liveness.py`» en «cambiar también qué
imagen llega hasta ahí», que es una decisión de más calado.

`scripts/capture-attack-set.mjs` graba el conjunto con el que medirlo, y
guarda de cada disparo tanto lo que el terminal envía como el frame
nativo, precisamente para poder responder a esa pregunta sin repetir la
sesión.
