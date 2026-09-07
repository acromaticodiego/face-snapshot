# ADR 0005 — REST síncrono antes que mensajería

**Estado:** aceptada · 2026-09-07

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
