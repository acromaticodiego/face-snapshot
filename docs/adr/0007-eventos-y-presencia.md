# ADR 0007 — Redis Streams para los eventos, y la presencia en el Access Service

**Estado:** aceptada · 2026-09-12
**Modifica:** [ADR 0005](0005-rest-antes-que-mensajeria.md)

## Contexto

El sistema tenía que saber quién está dentro, en qué estado de su
jornada, y desde cuándo. Eso obliga a decidir dos cosas que parecen
independientes pero no lo son: por dónde viajan los hechos de acceso, y
quién es dueño del estado de presencia.

El ADR 0005 decidió no tener broker y dejó anotadas las condiciones para
reconsiderarlo. Tres de las cuatro se cumplen ya:

- La auditoría de presencia debe salir del camino crítico.
- El Access Service necesita poder tener varias réplicas, y las ventanas
  de votación tendrían que compartirse.
- Hay que notificar a un sistema externo: el nuevo Shift Service.

## Decisión

**Redis, y solo Redis**, con dos responsabilidades, ninguna de las
cuales es decidir accesos:

1. **Redis Streams** transporta los eventos de acceso hacia el Shift
   Service.
2. **Las ventanas de votación** se guardan compartidas, lo que cierra la
   limitación de escalado que el README arrastraba desde el principio.

Y, por separado:

3. **La presencia física vive en `access_svc`**, no en el nuevo
   servicio.

## La decisión difícil: dónde vive la presencia

El anti-passback —no puedes entrar dos veces sin haber salido— parece
cosa del servicio de turnos, porque suena a asistencia. No lo es: es una
**decisión de acceso**, y este sistema tiene una sola autoridad para eso.

Se consideraron tres opciones.

| Opción | Por qué se descartó |
|---|---|
| Preguntar al Shift Service por HTTP | Una llamada de red en el camino crítico de cada frame; un ciclo, porque el Shift Service consume los eventos que produce el Access Service; y la obligación de elegir entre abrir la puerta a todo el mundo o a nadie cuando ese servicio no responda |
| Leer la presencia de una clave en Redis, escrita por el Shift Service | Eventualmente consistente: una clave desfasada o ausente desactiva el anti-passback **en silencio**, que es el peor modo de fallo posible para un control de seguridad. Y convierte a Redis en dependencia dura de la puerta |
| **Una tabla en `access_svc`** | La elegida |

El principio que resuelve el empate:

> **El estado que gobierna una puerta no puede ser eventualmente
> consistente.**

La tabla `presence` tiene cinco columnas y se escribe en la **misma
transacción** que la sesión emitida, el asiento de auditoría y el evento
de salida. O se guarda todo, o no se guarda nada.

Esto **no duplica el dominio de turnos**, y la distinción es la clave de
toda la fase:

- En `access_svc` vive el **hecho físico**: dentro o fuera de esta zona.
  Gobierna cerraduras, así que necesita consistencia fuerte.
- En `shift_svc` vive su **interpretación laboral**: en turno, en
  descanso, horas acumuladas, línea de tiempo. No abre nada, así que
  tolera ir unos segundos por detrás.

Que las dos vistas discrepen durante un segundo no es un fallo: es el
diseño. Una hoja de horas puede ir por detrás; una cerradura, no.

## Entrega de eventos: outbox transaccional

Escribir en PostgreSQL y publicar en Redis no se puede hacer de forma
atómica: son dos sistemas distintos. Publicar justo después de confirmar
la transacción pierde el evento si el proceso muere entre ambas cosas.

Aquí eso pesa más que en otros dominios. **Un evento de acceso perdido
no es telemetría que se pueda estimar después: son horas trabajadas que
no se le computan a una persona.**

Por eso el evento se escribe en la misma transacción, en una tabla de
outbox, y un relay lo publica después. La garantía resultante es **"al
menos una vez"**, y es la que se quiere: entre repetir y perder, se
repite. Lo que la vuelve inofensiva es que el consumidor sea idempotente
por `eventId`, impuesto por un índice único y no por una comprobación
previa que dos procesos podrían pasar a la vez.

El relay toma su lote con `FOR UPDATE SKIP LOCKED`, así que varias
réplicas se reparten la cola sin coordinarse y sin que haya que designar
una que publique.

## Por qué Redis y no RabbitMQ, NATS o Kafka

| | Redis Streams | RabbitMQ | Kafka |
|---|---|---|---|
| Piezas nuevas que operar | Una, que además ya hacía falta para las ventanas de votación | Una más | Una más, y pesada |
| Retención y reproceso | Sí, con grupos de consumidores y PEL | Limitada | Sí, es su fuerte |
| Coste operativo a esta escala | Bajo | Medio | Alto |

Kafka sería la respuesta correcta con millones de eventos al día. Aquí
son unos miles, y el volumen no justifica ni la memoria ni la
configuración que pide. Redis, además, entraba igualmente por la puerta
de las ventanas de votación: elegirlo también como bus evita añadir una
segunda pieza de infraestructura para el mismo problema.

## Consecuencias

**Buenas**

- Cae la limitación #3 del README: el Access Service ya puede replicarse.
- El cálculo de horas está fuera del camino crítico; si el Shift Service
  se cae, nadie se queda en la puerta.
- El Shift Service es reconstruible: borrar su base de datos y
  reprocesar el stream devuelve el mismo estado.
- La votación degrada a memoria si Redis no responde, y la dirección del
  fallo es segura: sin estado compartido cuesta **más** entrar, nunca
  menos.

**Limitaciones asumidas**

- **El consumidor no escala horizontalmente.** Con varios consumidores
  en el grupo, los eventos de una misma persona podrían procesarse a
  destiempo. La máquina de estados descarta lo desordenado, así que el
  efecto sería perder transiciones y no corromperlas, pero escalar de
  verdad exigiría repartir por persona en varios streams.
- **Hay una ventana de aproximadamente un segundo** entre la evaluación
  del anti-passback y su aplicación, porque en medio ocurre la votación.
  En esa ventana solo caben frames de la misma persona, y una persona no
  puede estar en dos puertas a la vez; con anti-spoofing pendiente
  (limitación #1), una fotografía en una segunda puerta sí podría
  colarse en ese hueco.
- **Redis no es de alta disponibilidad.** Una instancia, sin réplica.
  Aceptable porque ninguna de sus dos funciones puede dejar a nadie
  fuera de un edificio.

## Cuándo reconsiderarlo

- Cuando el Shift Service necesite varias réplicas: entonces hay que
  partir el stream por persona o por sede.
- Cuando aparezca un tercer consumidor de los mismos eventos con
  necesidades de retención larga: ahí Kafka empieza a justificarse.
- Cuando la cola pendiente de la outbox deje de ser anecdótica: es la
  señal que ya expone `/health`.
