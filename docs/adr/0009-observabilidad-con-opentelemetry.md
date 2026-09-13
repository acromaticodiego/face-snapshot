# ADR 0009 — OpenTelemetry con colector en medio, y la traza cruza el bus

**Estado:** aceptada · 2026-09-13

## Contexto

El sistema tenía seis servicios, dos bases de datos lógicas y un camino
asíncrono, y ninguna forma de responder tres preguntas:

1. **¿Cuánto tarda de verdad un frame, y en qué?** El Vision Service
   cronometraba `analyze` entero como un solo número. Importa porque el
   margen del umbral es estrecho —0.0641 de separación entre nubes con
   datos reales, frente al 0.2552 que midió el [ADR 0003](0003-umbral-y-votacion.md)
   sobre fotos de archivo— y lo que hace falta no es cambiar el número
   sino mejorar la captura. Para saber cuánto se puede gastar en una
   captura mejor hay que saber primero en qué se gasta el tiempo ahora.

2. **¿Está saliendo el camino asíncrono?** El Shift Service es una
   proyección: si se atasca, no falla nada visible. Las puertas abren,
   el Access Service responde, ninguna petición da error. Lo único que
   ocurre es que las horas de la gente se congelan, en silencio.

3. **¿Existe de verdad la arquitectura de eventos?** Un diagrama con
   una flecha de Redis en medio no demuestra nada.

## Decisión

**OpenTelemetry en los seis servicios, con un Collector en medio,
Tempo para las trazas y Prometheus + Grafana para las métricas.** Y el
contexto de traza viaja **con el evento** a través de la outbox y del
bus, de modo que una sola traza va del frame hasta la transición de
turno.

## Por qué un colector y no exportar directo

Tres motivos, en orden de peso:

- **Cambiar de backend no debe tocar seis servicios.** Aquí el destino
  es una línea de un archivo; allí serían seis despliegues.
- **Node y Python configuran igual**: un endpoint OTLP y nada más.
- El conector `spanmetrics` **fabrica las métricas de latencia y error
  a partir de las propias trazas**. Sin él habría que instrumentar a
  mano en cada servicio las mismas métricas que las trazas ya
  contienen, y acabarían sin cuadrar entre sí.

## Por qué Tempo y no Jaeger

Jaeger es un contenedor y cero configuración, y su visor es más cómodo.
Pero la captura que justifica esta fase —la traza que cruza el bus— se
mira **junto a** las métricas que salen de esas mismas trazas. Con
Jaeger serían dos interfaces sin relación entre sí; con Tempo, una
sola, y el salto de un pico de latencia a la traza concreta que lo
causó funciona.

## Cómo se cose la traza a través del bus

Esta es la decisión de fondo, y la que tiene contrapartidas.

Entre que se concede un acceso y que el relay publica el evento pasa
hasta un segundo, y son **dos procesos distintos**. El contexto de la
petición original ya no existe cuando el relay actúa.

La solución: `outbox_events` gana una columna `trace_context` con la
cabecera `traceparent`, **escrita en la misma transacción que el
evento** —el único momento en que la petición sigue viva—. El relay la
recupera, abre su span de publicación colgando de ahí, e inyecta su
propio contexto en un campo del mensaje de Redis. El consumidor lo
extrae al otro lado.

**El campo va separado del payload a propósito.** El contexto de traza
es metadato del *transporte*, no parte del contrato del evento. Metido
dentro del JSON, el validador del consumidor tendría que conocerlo y
una versión del Access Service sin telemetría rompería el esquema.

### Lo que se acepta a cambio

La convención de OpenTelemetry para mensajería recomienda un **enlace**
(*span link*) en lugar de padre-hijo cuando hay lotes o abanico, porque
un consumidor puede procesar mensajes de muchas trazas a la vez. Aquí
la relación es uno a uno y una traza conectada vale mucho más: enseña
de un vistazo que el camino asíncrono existe.

La contrapartida es real y hay que saber leerla: **la traza dura más
que la petición HTTP que la abrió**, y el hueco que se ve en medio
—unos 450 ms en las mediciones— **no es latencia, es el intervalo de
sondeo del relay**. Si algún día se adopta muestreo por cola con
criterio de lentitud, estas trazas parecerán todas lentas.

Si una fila no trae contexto —cualquier cosa anterior a esta decisión,
o publicada con la telemetría apagada— se publica y se procesa igual,
sin span. **La observabilidad no puede ser requisito para que un paso
llegue al Shift Service.**

## Lo que NO se traza, y por qué es tan importante como lo que sí

Tres bucles de fondo giran continuamente: el relay cada segundo, la
espera del consumidor cada cinco, y los medidores cada quince. Sin
suprimirlos serían **más de cien mil trazas diarias que solo dicen "no
había nada"**, y enterrarían las que importan. Un almacén de trazas
lleno de ruido es un almacén de trazas que nadie vuelve a abrir.

Lo mismo con las sondas de salud: Docker pega en `/health` cada 30 s en
cada servicio, y eso no se traza.

De aquí salió el error que más costó encontrar, y queda anotado porque
se volverá a cometer: **el span de publicación heredaba la supresión**,
porque se derivaba del contexto activo. Nacía sin registrar y el tramo
asíncrono no aparecía en ninguna traza, sin ningún error por ningún
sitio. Se extrae desde `ROOT_CONTEXT`: el único padre legítimo de ese
span es el que viene guardado en la fila.

## Métricas: solo las que ninguna traza puede dar

Las RED —peticiones, errores, latencia— salen solas de las trazas.
Duplicarlas sería trabajo inútil y, peor, dos números que acabarían sin
cuadrar. A mano se instrumenta únicamente lo que no habla de peticiones
sino del **estado del sistema**: decisiones por motivo, distribución de
similitudes, y las dos colas del camino asíncrono.

El panel de operación del producto ya calcula algunas de estas cosas en
SQL sobre el histórico. No sobra ninguna de las dos: aquel sirve para
mirar lo que pasó, estas para **alertar** y ver tendencia sin agregar
sobre la base de datos en cada refresco.

### Cardinalidad

El conector fabricaba una serie por **cada** span, incluidos los cinco
de *middleware* de Express por petición y los del pool de PostgreSQL:
spans de cero milisegundos que no describen ninguna operación. Las
métricas se alimentan ahora de una tubería aparte que solo deja pasar
`SERVER` y `CONSUMER` —las entradas de trabajo del sistema—, más las
tres etapas del pipeline de visión como excepción deliberada. Los
`CLIENT` se descartan porque duplican al `SERVER` del otro lado.

A Tempo sigue yendo todo: al investigar un caso concreto se quiere el
recorrido completo.

## Lo que se dejó fuera a propósito

- **OpenTelemetry en el navegador.** Obligaría a abrir CORS del
  colector y a cargar un *bundle* en el frontend, por un span.
- **Muestreo por cola.** Es la respuesta correcta en producción —
  quedarse con las lentas y las que fallan en vez de con una de cada N
  al azar— pero aquí se conservan todas las trazas. El muestreo queda
  como variable de entorno, no cableado.
- **Alta disponibilidad de la plataforma.** Un colector, un Tempo, un
  Prometheus. Ninguno puede dejar a nadie fuera de un edificio.

## Consecuencias

**Lo que se pudo responder el primer día**, medido sobre el stack real:

| Etapa | p95 |
|---|---|
| Petición completa | ~1 s |
| `vision.detect` (rostros.pt) | ~740 ms |
| `vision.embed` (ArcFace) | ~450 ms |
| `vision.align` | ~31 ms |
| Búsqueda en pgvector | ~1.2 ms |

**El cuello de botella es el detector, no el embedding.** Y la búsqueda
vectorial —la sospechosa intuitiva, la que justifica el índice HNSW y
la extensión— cuesta algo más de un milisegundo y no interviene en la
conversación. Eso cambia dónde hay que mirar para mejorar la captura.

> Son medidas de contenedores sin GPU en un portátil, no de hardware de
> producción. Lo que vale es la **proporción entre etapas**, no los
> valores absolutos.

**El coste:** cuatro contenedores más y alrededor de 1 GB de memoria
adicional, una columna nueva en `outbox_events`, y un archivo de
arranque repetido en los cinco servicios Node. Sobre esto último: el
[ADR 0008](0008-sin-paquete-de-contratos-compartido.md) retiró el
paquete compartido porque compartir DTOs acopla despliegues. Aquí no
hay ningún contrato —es configuración de arranque— y las cinco copias
son idénticas, porque el nombre y la versión salen del `package.json`
de cada servicio.
