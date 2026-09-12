# ADR 0008 — Cada servicio es dueño de sus tipos; se retira el paquete de contratos

**Estado:** aceptada · 2026-09-12

## Contexto

El proyecto tenía un paquete `packages/contracts` con los DTOs y
esquemas zod "compartidos entre los servicios".

No lo compartía nadie. Ningún `package.json` lo declaraba como
dependencia, no estaba en la matriz del CI, y los cinco servicios
declaraban sus tipos por su cuenta.

Y había empezado a mentir. Al añadir el dominio de autorización,
`AccessReasonSchema` se quedó con siete valores mientras el Access
Service y el frontend tenían doce: le faltaban los cinco motivos de
denegación por permisos. `VerifyFrameResponseSchema` tampoco tenía el
campo `location`. Un contrato que nadie importa no se rompe cuando
queda desfasado: simplemente deja de describir el sistema, en silencio.

## Decisión

**Se elimina `packages/contracts`.** Cada servicio declara los tipos de
su propia frontera.

## Motivos

**Compartir DTOs entre microservicios acopla despliegues.** Es el
argumento de fondo, y no es una racionalización a posteriori: si los
cinco servicios importan el mismo paquete, cambiar un campo obliga a
publicar una versión y a coordinar cinco despliegues, que es
exactamente la rigidez que se evita separándolos. Un servicio debe
poder evolucionar su representación interna sin pedir permiso.

**Ya funcionaba así de hecho.** Retirarlo no cambia el comportamiento
de nada; solo deja de prometer una garantía que no existía.

**Cablearlo de verdad costaba caro.** Convertirlo en un workspace real
obliga a mover el contexto de construcción de los Dockerfile a la raíz
del repositorio y a tocar los cinco servicios. Es una fase en sí misma,
y su beneficio —no repetir unas decenas de líneas de tipos— no la paga.

## Qué se hace en su lugar

Los contratos que sí cruzan una frontera se declaran **en el lado que
los produce**, con una prueba que los fija:

- `access-service/src/outbox/access-events.ts` describe lo que sale por
  el bus, y `passage.events.spec.ts` comprueba que el evento construido
  es el que dice el contrato.
- `shift-service/src/consumer/access-event.parser.ts` **valida con zod
  lo que llega**, aunque lo produzca un servicio propio. El bus es una
  frontera entre procesos que se despliegan por separado: el tipo de
  TypeScript no vale nada al otro lado de la red, y un campo que
  desaparece tiene que dar un error claro al recibirlo y no un
  `undefined` que acabe escribiendo una jornada con la hora en blanco.

Esa validación en el consumidor es lo que un paquete compartido no
daba, porque un tipo compartido se comprueba al compilar y el problema
ocurre en ejecución, entre dos versiones distintas desplegadas a la vez.

## Consecuencia

Unas decenas de líneas de tipos están duplicadas entre servicios. Es el
precio, es conocido, y es menor que el de un contrato que aparenta
existir y no existe.

Si algún día conviene volver a compartir, la forma correcta ya no es un
paquete de TypeScript sino un esquema versionado del que se generen los
tipos de cada lado —OpenAPI para el REST, algo equivalente para los
eventos—, con la versión viajando en el propio mensaje.
