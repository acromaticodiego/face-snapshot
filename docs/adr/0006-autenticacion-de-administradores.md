# ADR 0006 — Autenticación de administradores en un servicio propio

**Estado:** aceptada · 2026-09-07

## Contexto

Las rutas `/admin/*` estaban abiertas: cualquiera con acceso a la red
podía registrar o eliminar personas. Había que cerrarlo.

## Decisión

Un **Auth Service** independiente (NestJS + Prisma, schema `auth_svc`)
que emite tokens de administración, y un guard en el Gateway que los
verifica.

## Por qué un servicio aparte y no dentro del Face Service

En el ADR 0002 y en el README ya se había anticipado: las personas que
**administran** el sistema y las personas que el sistema **reconoce** son
dominios distintos que solo comparten la palabra "persona".

La consecuencia concreta y verificable es de seguridad: `admin_users`
—que guarda hashes de contraseñas— vive en un schema con su propio rol de
PostgreSQL. Ni el Face Service ni el Access Service pueden leer esa tabla
**aunque su código lo intentase**, porque el permiso no existe a nivel de
base de datos.

La tabla estaba inicialmente en `face_svc`. Se retiró de allí con la
migración `20260907000011_drop_admin_users`.

## Decisiones de implementación

### argon2id, no bcrypt

Se usa `@node-rs/argon2` con los parámetros recomendados por OWASP
(19 MiB de memoria, 2 iteraciones, paralelismo 1).

argon2id resiste mucho mejor los ataques con GPU o hardware
especializado: su coste está en la **memoria**, y la memoria no se
paraleliza barata. bcrypt solo encarece el cálculo.

Se eligió la implementación en Rust (`@node-rs/argon2`) sobre la clásica
(`argon2`) porque distribuye binarios precompilados para musl, así que la
imagen Alpine no necesita compilador ni cabeceras de desarrollo.

### Sin filtración por mensaje ni por tiempo

El endpoint devuelve **siempre** "Credenciales inválidas": exista la
cuenta o no, esté desactivada, o sea la contraseña la incorrecta.
Distinguir los casos permitiría enumerar qué correos son administradores.

Y no basta con el mensaje: si la cuenta no existe, se verifica igualmente
la contraseña contra un **hash de descarte** generado al arrancar con los
mismos parámetros. Sin esto, los correos inexistentes responderían al
instante y los válidos tras calcular argon2, y esa diferencia de tiempo
delataría cuáles existen.

### Doble freno a la fuerza bruta

Se aplican dos límites porque cubren ataques distintos:

| Mecanismo | Qué frena |
|---|---|
| 10 intentos/minuto por IP | Barrido de muchas cuentas desde un origen |
| 5 fallos → bloqueo de 15 min | Ataque contra una cuenta concreta |

El segundo es necesario porque el primero no sirve si el atacante rota
direcciones IP.

### El tipo de token importa

El token lleva `typ: 'admin'`, y el guard lo comprueba. Sin esa
verificación, el token de sesión que recibe **cualquier persona
reconocida por la cámara** serviría para administrar el sistema: quien
tuviera la cara registrada podría borrar a los demás.

Hay una prueba automática de esto en `scripts/smoke-test.mjs`.

### La primera cuenta

`AdminBootstrapService` crea una cuenta si —y solo si— la tabla está
vacía. Resuelve el problema del huevo y la gallina: administrar exige ser
administrador.

Se niega a crearla si la contraseña tiene menos de 12 caracteres, o si el
correo no supera la misma validación que aplica el inicio de sesión. Esta
segunda comprobación se añadió tras un fallo real: el valor por defecto
era `admin@local`, que el validador rechaza por no tener punto en el
dominio, y creaba una cuenta con la que era **imposible entrar**.

## Limitaciones asumidas

**No hay revocación de tokens.** Un token robado sigue siendo válido
hasta que caduca (8 horas por defecto). Desactivar a un administrador
surte efecto en su siguiente inicio de sesión, no de inmediato.

Añadir revocación exigiría *refresh tokens* con estado en base de datos y
una consulta por petición en el guard, que hoy es puramente stateless.
Merece la pena cuando haya varios administradores; con uno o dos, la
complejidad no se justifica todavía.

**El token se guarda en `sessionStorage`.** Lo ideal sería una cookie
`httpOnly`, inaccesible desde JavaScript y por tanto inmune al robo por
XSS. Exige que Gateway y frontend compartan dominio, o tokens CSRF para
peticiones entre orígenes; ambas cosas condicionan el despliegue, que
todavía no está decidido.
