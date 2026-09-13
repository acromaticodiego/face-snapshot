# ADR 0011 — Voz e IA: el modelo propone, la persona firma

**Estado:** aceptada · 2026-09-13

## Contexto

La Fase 5 añade la **bitácora de relevo de turno**: un vigilante dicta
las novedades al terminar su jornada y el sistema las estructura en
incidencias.

Es el primer punto del proyecto donde un modelo de lenguaje toca el
dominio, y eso obliga a decidir algo antes que cualquier detalle
técnico: **qué autoridad tiene lo que el modelo produce.**

## Decisión

Un `voice-service` **sin estado**, simétrico al Vision Service, que
convierte audio en texto ordenado y **no decide nada**. Todo lo que
devuelve es un **borrador** que una persona revisa y confirma antes de
que se guarde en ninguna parte.

Es el mismo reparto que ya gobierna el resto del sistema:

| | Mide / propone | Decide |
|---|---|---|
| Reconocimiento | `vision-service` | `access-service` |
| Detección de vida | `vision-service` | `access-service` |
| **Bitácora** | **`voice-service`** | **la persona que firma el parte** |

### Por qué la persona y no el servicio

Con el umbral de similitud o con el anti-passback, quien decide es otro
servicio porque la decisión es mecánica y hay una regla que aplicar. Un
parte de relevo no tiene regla: es el testimonio de alguien sobre lo que
pasó en su turno, y el documento que se lee cuando algo ha salido mal.

**Un renglón inventado en ese documento manda a una persona a investigar
un hecho que nunca ocurrió.** No hay política que arregle eso; lo único
que lo arregla es que quien lo vivió diga «sí, eso es lo que pasó».

## La defensa contra la invención es una comprobación, no una instrucción

Al modelo se le exige, por cada incidencia, una **cita literal** de la
transcripción. Después el servicio **comprueba que esa cita existe de
verdad** en el texto (`app/services/citas.py`) y marca la incidencia con
`citaVerificada`.

Esta es la parte de la que el proyecto se fía, y por un motivo concreto:

> «No inventes nada» es una instrucción y no se puede verificar.
> «Enséñame dónde lo leíste» sí.

Detalles que importan:

- **Se compara por secuencia de palabras**, ignorando mayúsculas y
  puntuación. Una comparación exacta marcaría como inventadas casi todas
  las citas buenas —basta con que el modelo se coma una coma—; una
  comparación difusa daría por buena una cita reescrita, que es
  justamente lo que se busca detectar.
- **Los acentos sí cuentan.** En español distinguen palabras distintas y
  la transcripción viene acentuada, así que quitarlos para comparar
  aflojaría la comprobación sin ganar nada.
- **Una cita que no cuadra se marca, no se borra.** Borrarla escondería
  que el modelo se inventó algo, y eso es exactamente lo que quien
  revisa el borrador necesita ver.

El número de incidencias sin respaldo va al span de la traza
(`voice.incidents.unbacked`). Si empieza a subir, o el modelo ha
cambiado de comportamiento o le está llegando algo que no se parece a un
parte de turno.

Es además **lo único de este servicio que se puede probar sin red**, y
por eso sus 16 casos corren en el CI: solo usan la biblioteca estándar.

## La degradación va en una sola dirección

El principio que ya gobierna el resto del sistema —un componente de
apoyo que falla no puede dejar a nadie tirado— aquí se traduce en un
orden de preferencia: **que quede constancia del turno.**

| Qué falla | Qué pasa |
|---|---|
| Gemini no responde | Se devuelve la transcripción sola, con `estructuraOmitidaPor` explicando por qué. El parte se registra igual |
| Deepgram no responde | `503` con código `TRANSCRIPTION_UNAVAILABLE`, para que el cliente ofrezca escribirlo a mano |
| Faltan las claves | El servicio **arranca igual** y lo avisa en el log |

Un vigilante que termina su jornada no puede irse sin dejar constancia
porque un proveedor externo esté caído.

**Un reintento, y solo uno**, ante fallos transitorios. No es tapar nada:
medido contra las APIs reales, Gemini devolvió `503 UNAVAILABLE` —«this
model is currently experiencing high demand»— en una petición y `200` en
la siguiente con el mismo cuerpo. Perder el parte de un turno entero por
un pico de demanda ajeno sería un mal reparto del coste. Si el segundo
intento también falla, la degradación de arriba sigue en pie tal cual.

## La asimetría de privacidad, dicha en voz alta

El README presume, con razón, de que **los datos biométricos no salen
del backend**: los vectores faciales están protegidos por el tipo
`Unsupported` de Prisma y no se guarda ninguna imagen.

**Este servicio rompe esa propiedad.** Manda audio de una persona a
Deepgram y su transcripción a Google, y la voz también es un dato
biométrico.

Lo que se hace al respecto:

- El audio **no se almacena en ningún sitio**: entra en memoria, se
  manda a transcribir y se suelta. Ni disco, ni caché, ni logs.
- **Ni el audio ni la transcripción ni el texto estructurado aparecen en
  los logs ni en los spans.** A la traza van métricas —bytes, segundos,
  confianza, número de incidencias—, nunca contenido. Una traza se mira
  en Grafana desde cualquier navegador con acceso, y el parte de un turno
  no tiene por qué estar ahí.
- Queda el **texto**, y es deliberado: el texto *es* el parte. Lo que se
  descarta es la voz.

Lo que **no** se puede seguir diciendo es que ningún dato biométrico sale
del sistema. Sale.

## Lo que se midió antes de elegir

No son valores por defecto copiados de una documentación. Se probaron
contra las APIs reales con 37.7 s de audio en español:

| | Resultado |
|---|---|
| `nova-3` vs `nova-2` | **1955 ms vs 8308 ms**, transcripción idéntica palabra por palabra |
| `smart_format=true` | Convierte «las tres y cuarto» en «las 3 y 4º», y «pasillo dos» en «pasillo 2» |
| `smart_format=false` | Conserva las horas tal y como se dijeron |

**`smart_format` se queda apagado.** En un parte de relevo la hora a la
que saltó una alarma es el dato por el que alguien va a volver a leerlo,
y se prefiere un número escrito con letra y correcto a uno en cifras y
falso.

El modelo estructurador se fija con **versión concreta**
(`gemini-3.8-flash`) y no con un alias tipo `gemini-flash-latest`: un
alias cambia de modelo por debajo sin que nadie toque nada, y con él
cambiarían las incidencias que el sistema saca del mismo parte. Con
temperatura **cero**, por lo mismo: dos partes iguales tienen que dar el
mismo borrador.

## Alternativas descartadas

**Los SDK oficiales de Deepgram y de Google.** Cada llamada es un POST.
Un SDK traería su propio árbol de dependencias y su propio ritmo de
cambios a cambio de ahorrar unas líneas, en un servicio cuya gracia es
ser pequeño.

**Que el `voice-service` guarde la bitácora.** Rompería la simetría con
el Vision Service —sin estado, sin base de datos— e introduciría un
segundo stack de persistencia en Python, con sus migraciones a mano, sin
resolver nada que no resuelva un servicio NestJS más.

**Un solo número de confianza en lugar de la verificación de citas.** Es
lo que devuelven casi todas estas APIs y no sirve aquí: mide cuán seguro
está el modelo, no si lo que dijo estaba en el texto. Un modelo puede
estar muy seguro de algo que se inventó.

## Lo que viene, y ya está decidido

**La bitácora vivirá en un `logbook-service` propio**, con su schema
`logbook_svc`, y no en `shift_svc`. El motivo no es de gusto: el
[ADR 0007](0007-eventos-y-presencia.md) define el Shift Service como una
**proyección**, reconstruible entera reprocesando el stream de eventos
sin que nadie se quede fuera de un edificio. Un texto que dictó una
persona **no se puede reconstruir de ningún evento**, y meterlo ahí
destruiría esa propiedad, que es lo que hace defendible el diseño de la
Fase 2.

Tampoco en `access_svc`: es la autoridad de las puertas y no se le añaden
escrituras que no abren nada.

El **servidor MCP** será cliente del Gateway con un token de
administración, nunca de la base de datos ni de los servicios internos,
para que pase por los mismos guards que todo lo demás en lugar de abrir
una segunda puerta de entrada. **Solo herramientas de lectura**: ninguna
abrirá una puerta ni escribirá nada.

## Una nota sobre el entorno, que costó una hora

Si `api.deepgram.com` no resuelve dentro del contenedor, no es el
código: hay routers domésticos que devuelven respuesta vacía para ese
nombre concreto mientras resuelven todo lo demás. El arreglo correcto es
poner un DNS que funcione en el **host**; el `docker-compose.yml` lleva
una línea `dns:` comentada para parchearlo solo en este servicio, y
conviene saber que se está parcheando.

Es además el **único servicio del sistema que necesita salir a
Internet**, así que es el único al que esto le puede pasar.
