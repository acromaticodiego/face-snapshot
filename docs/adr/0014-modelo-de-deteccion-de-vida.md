# ADR 0014 — MiniFASNet sustituye a la señal espectral

**Estado:** aceptada · 2026-09-14

> Sustituye la **señal** elegida en el [ADR 0010](0010-deteccion-de-vida.md).
> La **estructura** de aquel ADR —medir en el Vision Service, decidir en
> el Access Service, tres modos, `SOFT` por defecto, un frame sospechoso
> no acumula voto— se conserva entera y sin cambios.

## Contexto

El ADR 0010 eligió dos señales espectrales sobre el rostro —`detailRatio`
y `patternPeak`— y dejó anotado que no estaban validadas. Cuando hubo un
conjunto de ataque real con el que medirlas, resultaron no separar.

La primera limitación del README ha sido siempre la misma: el sistema no
es apto para control de acceso real porque su defensa contra
suplantación no está validada. Esto es lo que cierra esa frase.

## Lo que se midió, y con qué

`datasets/liveness/`: 40 caras reales y 40 fotos de esas caras en la
pantalla de un móvil, capturadas con la misma webcam del despliegue, en
tres tandas separadas en el tiempo, y con dos variantes por disparo —la
de 640 px que el terminal envía de verdad, y el frame nativo de 1280—.
No está en el repositorio a propósito: son rostros de personas concretas
y el `.gitignore` excluye `/datasets/` entero.

El detector no encuentra la cara en 2 de los 40 ataques, así que las
cifras de ataque van sobre **38**. Esas dos imágenes quedan fuera de las
medias en vez de contarse como aciertos: una imagen sin cara no dice
nada sobre la señal.

Todo lo que sigue sale de `node scripts/measure-liveness.mjs` contra el
stack levantado, y se puede volver a sacar corriéndolo.

## La señal anterior no separa

Variante `terminal`, que es la que el sistema ve:

| | cara real (n=40) | pantalla (n=38) |
|---|---|---|
| `detailRatio` | 0.4763 ± 0.0412 | 0.4254 ± 0.0408 |
| `patternPeak` | 18.64 ± 3.59 | 33.08 ± 9.45 |

El mejor corte posible sobre estos mismos datos —el caso más favorable
que existe, porque se elige sabiendo las respuestas— deja el
`detailRatio` en APCER 10.5 % con BPCER 30.0 %. Inservible sin más
discusión.

El `patternPeak` parece otra cosa: 0.0 % y 17.5 %. Y ahí está la
trampa, que es lo que de verdad hay que aprender de todo esto.

### Un corte elegido sobre los propios datos miente

Eligiendo el corte **solo con la primera tanda** y aplicándolo a las
siguientes, que no participaron en elegirlo:

| señal · variante | en su tanda | fuera de ella |
|---|---|---|
| `detailRatio` · terminal | APCER 0.0 % · BPCER 25.0 % | APCER 30.0 % · BPCER 35.0 % |
| `patternPeak` · terminal | APCER 0.0 % · BPCER **0.0 %** | APCER **25.0 %** · BPCER **20.0 %** |
| `patternPeak` · nativo | APCER 0.0 % · BPCER 5.0 % | APCER 5.0 % · BPCER 30.0 % |

El pico periódico daba **cero error** dentro de la tanda que eligió su
corte, y una de cada cinco personas fuera del edificio con uno de cada
cuatro ataques dentro al cambiar de tanda. El corte había aprendido la
luz de aquella tarde, no el ataque.

Parte del motivo es medible: **dentro de las 40 caras reales**,
`patternPeak` correlaciona **+0.39 con el ancho de la cara** (que va de
148 a 343 px). Buena parte de lo que mide es a qué distancia estás de la
cámara, no si hay una pantalla delante — y la distancia cambia de una
tanda a otra, que es exactamente por donde se rompió.

La señal nueva depende bastante menos de eso: la misma correlación
dentro de la misma clase es **−0.24**.

> Ojo con esta cifra si se recalcula: mezclando las dos clases,
> `spoofScore` sale correlacionando **+0.47** con el ancho, más que la
> señal vieja. Es un artefacto, no un hallazgo: las caras reales salen
> a la vez más cerca y con puntuación alta, así que la clase arrastra
> las dos variables. La correlación que dice algo es la de dentro de
> cada clase.

**Esta comprobación vive ahora dentro del medidor**, no en la cabeza de
quien lo ejecuta. `medir_vida.py` parte el conjunto por tanda de
captura, elige el corte en la primera y lo aplica al resto, y lo hace
también con las señales refutadas: la tabla de arriba se reproduce
corriendo el script.

## La señal nueva sí separa

MiniFASNet, dos pesos del repositorio
[minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing)
(Apache-2.0), entrenados con escalas de recorte 2.7 y 4.0. Se promedian
sus dos softmax y se toma la probabilidad de la clase «cara real».

Variante `terminal`, el mismo conjunto y la misma ejecución:

| | cara real (n=40) | pantalla (n=38) |
|---|---|---|
| `spoofScore` | 0.9851 ± 0.0399 | 0.1187 ± 0.1517 |
| peor caso | **0.7769** | **0.5388** |

Entre 0.5388 y 0.7769 no cae **ni una sola imagen** de las 78. Con el
corte en medio: APCER 0.0 %, BPCER 0.0 %.

Y la comprobación que hundió a la señal anterior:

| | en su tanda | fuera de ella |
|---|---|---|
| `spoofScore` · terminal | APCER 0.0 % · BPCER 0.0 % | APCER 0.0 % · BPCER 0.0 % |
| `spoofScore` · nativo | APCER 0.0 % · BPCER 0.0 % | APCER 0.0 % · BPCER 5.0 % |

El corte que sale de la primera tanda es 0.6334, y aplicado a las
siguientes no se equivoca en la variante que el sistema usa.

**El modelo nunca vio estas imágenes**, y no se ha entrenado ni ajustado
nada con ellas.

### Lo que cuesta

Medido dentro del contenedor, 30 llamadas seguidas sobre un frame de
640x360 con la máquina en reposo: **mediana 9.2 ms, p95 16.6 ms**. El
detector se lleva ~740 ms del mismo frame. Es entre el 1 % y el 2 % del
presupuesto.

## El umbral: 0.60, y por qué no 0.5

`LIVENESS_MIN_SPOOF_SCORE=0.60`.

La decisión nativa del modelo —`argmax` sobre las tres clases— equivale
más o menos a cortar en 0.5, y con ella se cuela un ataque de los 38: el
que dio 0.5388, que es el mejor del conjunto (el móvil llenando el
encuadre, pantalla brillante, marco casi invisible). Eso es el APCER
2.6 % que salió en la primera evaluación.

0.60 cae dentro del hueco y lo cierra. Elegir el corte sabiendo dónde
está el hueco es exactamente el error que se cometió con la señal
anterior, así que se comprobó aparte: el corte que sale **solo de la
primera tanda**, sin ver el resto, es 0.6334, y también acierta en la
reserva. 0.60 no es un número que funcione únicamente mirando todas las
respuestas, y queda por debajo del que salió a ciegas, que es el lado
prudente: de los dos errores, el que deja a una persona real en la calle
es el que más cuesta.

**El umbral está atado al modelo que lo produce.** La respuesta viaja
con `modelInfo.spoofDetector` y `spoofDetectorVersion` justo para esto:
si cambian, la escala del número cambia con ellos y hay que volver a
medir antes de tocar el umbral.

## El defecto sigue siendo `SOFT`, y ahora por otro motivo

Antes era por falta de medida. Ya no: la señal está medida y separa.

Lo que falta ahora es **cobertura**. El conjunto es de **una** persona y
**un** móvil. No hay foto impresa, ni vídeo reproducido en pantalla, ni
máscara, ni una segunda cara, ni otra cámara, ni otra iluminación. La
ISO/IEC 30107-3 pide bastante más que esto para escribir «APCER» sin
comillas.

Decir «APCER 0 %» de 38 ataques de un solo tipo no es lo mismo que decir
que el sistema para ataques de presentación, y el modo por defecto tiene
que reflejar esa diferencia. Además hay una advertencia concreta que
salió al probar: alimentado con **ruido puro**, el modelo devuelve 0.97
de «cara real». No es un validador de rostros: da por hecho que hay una
cara porque el detector ya la encontró. Su número no significa nada
fuera de ese contexto.

### Qué haría falta para encender `HARD`

1. `SOFT` corriendo con tráfico real, mirando `acceso_sospechas_de_vida`
   en Grafana. Tráfico constante sin que nadie ataque nada significa que
   el umbral está mal.
2. Grabar los ataques que faltan —foto impresa, vídeo en pantalla, más
   de una persona— con `scripts/capture-attack-set.mjs`, y volver a
   pasar `scripts/measure-liveness.mjs`.
3. Solo entonces, y **por zona**, no globalmente.

## Decisiones de implementación que no son obvias

### La puntuación se mide sobre el frame original, no sobre el recorte alineado

Es justo la equivocación que hundió la señal anterior. Entre el sensor y
el recorte de 112x112 hay dos reducciones sin filtro antialias, y lo que
delata una recaptura no sobrevive a ellas. `spoof.py` recorta del frame
tal como llegó, con la caja del detector y el margen que cada peso
espera.

### Ausencia, nunca cero

Cuando no se puede medir, `spoofScore` viaja **ausente**. No como 0.0,
porque un cero significa «ataque segurísimo» y en modo `HARD` dejaría a
una persona real en la calle por un error de código.

La otra mitad de esa decisión está en `judgeFrame`, que no trata la
ausencia como sospecha —la misma regla del ADR 0010, que es lo que
permite actualizar los servicios en distinto orden sin cerrar todas las
puertas—. Las dos mitades tienen que coincidir, y cada una tiene su
prueba con su mutación comprobada.

### Si faltan los pesos, el servicio no arranca

Deliberadamente no se degrada a «arranca sin detección de vida». Eso
dejaría al Access Service sin evidencia, y sin evidencia no hay
sospecha: la protección se habría apagado **en silencio**. Un contenedor
que no levanta se ve; una defensa apagada, no.

El interruptor para no mirar existe y está donde vive la política:
`LIVENESS_MODE=OFF`.

### Los pesos van versionados, no se descargan al construir

Mismo criterio que `rostros.pt`. Lo que decide si una puerta se abre no
puede depender de que un tercero siga sirviendo un archivo, ni cambiar
de contenido sin que nadie se entere. Los checksums están en
`modelos/antispoof/PROCEDENCIA.md`.

La diferencia con los pesos de InsightFace, que sí se bajan al
construir, es deliberada: aquellos producen un vector que después se
compara contra un umbral propio; estos emiten un veredicto.

### La entrada va en 0–255

Estos modelos **no** esperan `[0, 1]`. Alimentados mal no fallan de
forma visible: responden lo mismo a una cara, a ruido puro y a una
imagen negra. Se perdió una tarde en eso, y está escrito en
`modelos/antispoof/PROCEDENCIA.md`.

Hay un test dedicado —`test_spoof.py::NoEstaCiego`— y se comprobó que
detecta el fallo: reintroduciendo el `.div(255)`, las cuatro entradas de
prueba pasan de separarse 0.95 a separarse 0.0048, y el test cae con ese
número en el mensaje.

### Las tres clases se dedujeron midiendo

`[0]` impreso · `[1]` cara real · `[2]` pantalla. El repositorio de
origen no las documenta.

## Qué se conserva de la señal anterior

`detailRatio` y `patternPeak` se siguen calculando y siguen viajando en
la respuesta. **No deciden nada.** Están ahí para poder verlas al lado
de la nueva mientras dure el despliegue, que es lo que hace comprobable
la afirmación de este ADR en vez de obligar a creerse una tabla. Se
retirarán cuando el modelo lleve tiempo corriendo.

El medidor las marca `[informativa, REFUTADA]` y no las deja suspender
el informe, con una prueba dedicada a que siga siendo así.

## Alternativas descartadas

**Seguir con la señal espectral, midiéndola antes de las reducciones.**
Era la vía que el ADR 0010 dejaba abierta. Cambiar qué imagen llega
hasta la medida cuesta ancho de banda y tiempo de detector por frame, y
hay que compararlo con lo que se gana. Aquí se gana: la alternativa
entrenada da 0 % y 0 % fuera de su tanda contra el 25 % y 20 % de la
espectral, y cuesta 9 ms.

**El reto activo (parpadear, girar la cabeza).** Sigue siendo la opción
que se podría demostrar del todo, porque una foto estática nunca pasa el
reto. Se mantiene descartada por lo mismo que en el ADR 0010: cambia la
experiencia, pasar por una puerta deja de ser instantáneo, y eso es una
decisión de producto. Queda anotada como la opción a recuperar si la vía
pasiva no basta contra los ataques que todavía no se han probado.
