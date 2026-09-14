# ADR 0012 — La bitácora: firmada, inmutable y con el cruce congelado

**Estado:** aceptada · 2026-09-13

## Contexto

El [ADR 0011](0011-voz-e-ia.md) decidió que el Voice Service produce
**borradores** y que la bitácora viviría en un servicio propio. Este ADR
recoge las decisiones de ese servicio, que son las que determinan si un
parte de relevo vale como registro o es solo texto guardado.

La pregunta de fondo es una: **¿qué hace que un parte de relevo se pueda
creer dentro de dos años?**

## Decisión 1 — Aquí solo entra lo ya firmado

**No hay borradores en la base de datos.** El Voice Service propone, la
persona revisa en el cliente, y solo lo que confirma llega al
`logbook-service`. No existe una columna de estado ni un campo
`isDraft`.

Un registro de seguridad a medio hacer, que nadie ha leído y que **parece
un parte**, es peor que no tener parte: alguien lo encontrará y lo
tratará como testimonio.

## Decisión 2 — Inmutable, y las correcciones son partes nuevos

No hay `PUT`, no hay `PATCH` y no hay `DELETE`. Ni en el servicio ni en
el Gateway.

Un parte que se puede editar después no prueba nada, porque quien lo lee
no puede saber si es lo que se declaró. Una corrección es un parte
**nuevo** que apunta al anterior con `correctsEntryId`, y los dos quedan.
Es como se corrige un libro de registro en papel: tachando y firmando al
lado, no arrancando la hoja.

Se comprueba que el parte corregido exista. Un puntero a un identificador
inventado convertiría la cadena de correcciones en algo que no se puede
seguir, que es justo lo que le da valor.

### Cerrar una incidencia sigue la misma regla · 2026-09-14

Una incidencia pendiente vive **dentro** de un parte firmado, así que
marcarla como cerrada en su propia fila haría que el documento dijera
algo distinto de lo que decía al firmarse. Cerrarla escribe una fila
nueva en `incident_resolutions` que la referencia, y las dos quedan.

Sin esto la lista de pendientes solo crecía: el ascensor roto de hace
tres meses le seguía apareciendo a quien entra mañana, y una lista que
nadie puede vaciar acaba siendo una que nadie lee. «Pendiente» pasa a
ser dos condiciones y no una: que el parte la marcara como que requiere
seguimiento, **y** que nadie la haya cerrado.

Lo que se gana además de vaciar la lista es poder responder **quién la
cerró y cuándo**, que con un booleano en `incidents` se habría perdido.

**Cerrar es idempotente**, y eso no es comodidad de interfaz. Dos
personas entrando al turno pueden pulsar el botón en el mismo segundo.
Una restricción única sobre `incident_id` impide la segunda fila, y el
servicio trata ese choque como éxito devolviendo la resolución que ya
existe: el trabajo estaba hecho, y responder un error haría que la
pantalla dijera que falló algo que salió bien. La comprobación previa no
basta —entre leer y escribir cabe otra petición—, así que el caso se
resuelve en el `catch` del `P2002` y tiene su prueba.

**Cierra cualquiera, no solo quien la abrió.** Es lo que un relevo de
turno significa: el del turno siguiente es precisamente quien puede
comprobar que el ascensor ya funciona. Por eso queda escrito quién fue;
sin esa firma, el botón sería uno de borrar.

## Decisión 3 — Quién firma sale del token, nunca del cuerpo

`personId` y `personName` los pone el Gateway a partir del token de
sesión facial y viajan en cabeceras (`X-Person-Id`, `X-Person-Name`). El
esquema de entrada **no tiene** un campo para la persona, y hay una
prueba que lo fija.

Es la misma regla que ya siguen `/home` y los descansos, y aquí es
todavía más importante: un parte vale porque lo firmó quien vivió el
turno. Si el cuerpo pudiera decir de quién es, cualquiera con una sesión
válida firmaría a nombre de otro.

Por el mismo motivo, **la vista de administración es de solo lectura**.
Un administrador que pudiera redactar un parte por otro convertiría la
bitácora en algo que no prueba nada.

Y en la base de datos: `logbook_svc` tiene su propio rol, y los demás
servicios tienen revocado el acceso. Que solo pueda escribir aquí quien
firma no depende de la disciplina del código.

## Decisión 4 — El cruce de accesos se congela al firmar

Un parte declara un periodo. Al firmarlo, el servicio pregunta al Access
Service qué registraron las puertas en esa franja y **guarda el resumen
dentro** del parte.

No se consulta al leer, y esa es la decisión. Un parte es evidencia de lo
que se sabía entonces: si se compusiera al abrirlo, el mismo documento
diría cosas distintas según el día, que es exactamente lo que un registro
no puede hacer. Es el mismo criterio que ya siguen los eventos de la
outbox y la auditoría de accesos, donde todo viaja desnormalizado para
que un hecho histórico siga describiendo lo que pasó.

**Un resumen, no las filas.** Un turno de ocho horas deja miles de
asientos, y copiarlos dentro de un parte duplicaría la auditoría, que ya
existe y es la autoridad sobre esos hechos. Se guarda el recuento y lo
**anormal**: denegaciones por motivo, anomalías, y hasta 50 sucesos
listados uno a uno. Si la lista se corta, el parte lo dice
(`notableTruncated`), porque enseñar solo los primeros cincuenta sin
avisar daría a entender que no hubo más.

Lo concedido se cuenta pero no se lista: quien entra al turno siguiente
no necesita el ir y venir nominal de sus compañeros durante ocho horas.

**Verificado contra el stack real:** un parte de 10,5 horas congeló 266
intentos, 9 concedidos y 257 denegados, con `BELOW_THRESHOLD` 252,
`NO_ROLE_ASSIGNED` 4 y `LIVENESS_FAILED` 1.

## Decisión 5 — Si el Access Service no responde, el parte se firma igual

El cruce enriquece el parte; no es el parte. Sin él se guarda
`accessSnapshot` a nulo y se sigue.

La alternativa —devolver un error y perder lo que alguien acaba de
dictar— sería la dirección de fallo equivocada, la misma que el proyecto
evita en la puerta, en la votación y en la telemetría. Por eso el
`depends_on` del compose es `service_started` y no `service_healthy`:
esperar a que el Access Service esté sano sería afirmar que sin él no se
puede firmar un parte, y sí se puede.

Un efecto secundario que hay que conocer: sin el Access Service tampoco
se sabe la **zona horaria** de la sede, y el día al que se imputa el
parte se calcula en UTC. Queda avisado en el log. Un parte con el día
posiblemente corrido es preferible a no tener parte.

**Verificado parando el contenedor:** `HTTP 201`, parte guardado,
`siteName` y `accessSnapshot` a nulo, y los dos avisos en el log.

## Decisión 6 — Cada incidencia dice de dónde salió

`PROPUESTA_ACEPTADA`, `PROPUESTA_EDITADA` o `ANADIDA_POR_PERSONA`.

No es decoración: es lo que permitirá responder con datos, dentro de unos
meses, **si el modelo sirve de algo**. Si casi todo acaba siendo editado
o añadido a mano, la estructuración automática está costando más trabajo
del que ahorra, y eso es una decisión de producto que conviene tomar
mirando números y no impresiones.

Junto a `quoteVerified` —que lo calculó el Voice Service comparando
contra la transcripción, no lo dijo el modelo— la bitácora guarda de cada
incidencia quién la propuso y si estaba respaldada por lo que se dijo.

## Decisión 7 — La hora se guarda tal y como se dijo

`mentionedTime` es texto: «las tres y cuarto». No se normaliza a un
instante.

Convertir «sobre las tres» en `03:00:00` inventa una precisión que nadie
declaró, y en un parte de relevo esa precisión falsa acaba citada en una
investigación como si fuera un dato. Es la misma razón por la que
`smart_format` de Deepgram va apagado (ADR 0011).

## Lo que se prueba, y por qué eso

Este servicio guarda testimonio y no lo deja editar. Las dos cosas que
hay que blindar son, por tanto, **qué se deja entrar** y **a qué día se
imputa**: una vez firmado, un parte mal validado ya no se arregla.

16 casos, lógica pura, sin base de datos ni contenedores. Cubren el
periodo declarado (invertido, más de 24 horas, en el futuro, con margen
para el desfase de reloj), la coherencia de un parte dictado sin
transcripción, que la persona no pueda venir en el cuerpo, los valores
por defecto prudentes, y el día local de la sede frente al del servidor.

**Se verificaron rompiendo el código**, como el resto del proyecto: cinco
mutaciones —permitir el futuro, quitar el tope de 24 horas, aceptar un
dictado sin transcripción, dar por verificada la cita por defecto y
permitir un periodo invertido— y cada una la atrapa **exactamente un**
caso.

## La consulta que justifica todo esto

`GET /me/logbook/pending`: lo que quedó sin cerrar, para quien entra al
turno. Una bitácora que solo se pudiera leer parte por parte obligaría a
repasar el turno anterior entero para enterarse de que el ascensor sigue
roto.

La sostiene un **índice parcial** sobre las incidencias pendientes. Son
la minoría; indexar también las cerradas haría el índice varias veces más
grande sin que nadie lo usara para buscarlas. Prisma no sabe expresar
índices parciales, así que vive solo en la migración, como los otros tres
del proyecto.

No filtra por persona a propósito: lo que quedó pendiente lo dejó otro.

## Alternativas descartadas

**Guardar los borradores.** Habría hecho falta un estado, una limpieza de
los que nadie firma, y la posibilidad de que alguien lea uno creyendo que
es un parte. El borrador vive en el cliente entre `POST /me/logbook/draft`
y `POST /me/logbook`, y si se pierde se vuelve a dictar.

**Que el Gateway compusiera el cruce al leer.** Es lo que ya hace en el
listado de personas, y aquí sería incorrecto: un parte cambiaría de
contenido según el día en que se abre.

**Deducir el periodo del turno en lugar de declararlo.** Obligaría al
Logbook Service a preguntar al Shift Service, añadiendo una segunda
dependencia saliente para un dato que quien firma sabe mejor que nadie.
Un parte es un testimonio sobre un intervalo, y su autor es quien dice
cuál es. Se valida que sea coherente, no que sea «el turno correcto».
