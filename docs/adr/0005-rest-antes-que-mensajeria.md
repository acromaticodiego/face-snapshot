# ADR 0005 — REST síncrono antes que mensajería

**Estado:** aceptada · 2026-09-07 · **parcialmente superada** por el
[ADR 0007](0007-eventos-y-presencia.md) el 2026-09-12

## Contexto

Los servicios necesitan comunicarse. Las opciones habituales son REST,
gRPC o una cola de mensajes (RabbitMQ, NATS, Redis Streams).

## Decisión

**REST síncrono sobre HTTP**, con multipart para las imágenes.
Sin Redis, sin RabbitMQ, sin NATS.

## Motivos

El flujo principal es **intrínsecamente síncrono**: el usuario está de
pie frente a la cámara esperando una respuesta. No hay nada que
desacoplar; una cola solo añadiría una capa entre la pregunta y la
respuesta que el usuario espera.

Añadir mensajería ahora significaría operar un broker más, con su
configuración, su monitorización y sus modos de fallo, para resolver un
problema que todavía no existe.

## Cómo queda preparado

Cada servicio habla con los demás a través de un **único cliente
encapsulado**:

- `face-service/src/vision/vision.client.ts`
- `access-service/src/face/face.client.ts`
- `api-gateway/src/proxy/service-clients.ts`

Ningún otro archivo hace peticiones de red. Cambiar el transporte a
gRPC o a una cola significa reescribir esos tres archivos, no rastrear
llamadas por toda la base de código.

## Cuándo reconsiderarlo

- Cuando la auditoría de accesos deba salir del camino crítico.
- Cuando haya que notificar a sistemas externos (torniquetes, alarmas).
- Cuando varias cámaras generen más carga de la que absorbe el
  procesamiento síncrono.
- Cuando el Access Service necesite varias réplicas y las ventanas de
  votación tengan que compartirse (ahí entraría Redis).

## Qué pasó después

El 2026-09-12 se cumplieron tres de esas cuatro condiciones a la vez, al
añadir el registro de jornada: la presencia tenía que salir del camino
crítico, apareció un consumidor externo (el Shift Service) y las
ventanas de votación pasaron a impedir el escalado.

Se añadió **Redis**, y solo Redis. El razonamiento está en el
[ADR 0007](0007-eventos-y-presencia.md).

**Lo que sigue vigente de este ADR:** el flujo de reconocimiento
—frame → identidad → veredicto— sigue siendo REST síncrono, porque el
usuario sigue de pie esperando una respuesta y ahí no hay nada que
desacoplar. Lo que se desacopló fue lo que ocurre *después* de abrir la
puerta.

Y la preparación que este ADR dejó hecha funcionó como se esperaba: al
estar todas las llamadas entre servicios encapsuladas en un cliente por
servicio, añadir el bus no obligó a rastrear peticiones por la base de
código.
