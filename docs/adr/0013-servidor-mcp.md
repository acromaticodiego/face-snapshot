# ADR 0013 — El servidor MCP: cliente del Gateway, y de solo lectura

**Estado:** aceptada · 2026-09-13

## Contexto

La Fase 5 preveía un servidor MCP que expusiera el dominio como
herramientas, para que un modelo pueda responder preguntas sobre el
sistema: quién está dentro, qué jornadas hay abiertas, qué dejó
pendiente el turno anterior.

Es la primera vez que algo de fuera del proyecto puede consultar sus
datos por iniciativa propia, y eso obliga a decidir dos cosas antes de
escribir una línea: **por dónde entra** y **qué puede hacer**.

## Decisión 1 — Entra por el Gateway, como todo lo demás

El servidor MCP es **un cliente más del API Gateway**. Se autentica con
una cuenta de administración, pasa por los mismos guards que el
navegador y no tiene ni un privilegio que no tenga un administrador
sentado delante del panel.

Consultar PostgreSQL directamente habría sido más rápido y más cómodo —
el servidor corre en la misma máquina— y habría sido un error:

- **Sería una segunda puerta de entrada que nadie vigila.** El README
  dice desde el principio que el Gateway es el único punto de entrada, y
  eso deja de ser cierto en cuanto algo lee por debajo.
- **Se saltaría el aislamiento por roles** que el proyecto se ha tomado
  el trabajo de montar: un cliente con acceso directo a la base de datos
  vería a la vez los vectores faciales, los hashes de contraseñas y las
  horas de todo el mundo, precisamente lo que cuatro roles de PostgreSQL
  impiden.
- **No pasaría por el rate limiting ni por la normalización de errores**,
  y los fallos saldrían con detalles internos dentro.

El precio es una llamada HTTP por consulta. A escala de «un modelo
preguntando algo», es gratis.

## Decisión 2 — Solo lectura, y anunciado como tal

No hay ninguna herramienta que escriba. Ni abrir una puerta, ni firmar
un parte, ni declarar un descanso, ni corregir una jornada. Las tres se
anuncian con `readOnlyHint`.

> Un modelo conectado a esto puede contar lo que pasó. No puede hacer
> que pase nada.

No es prudencia genérica sobre los modelos de lenguaje: es que la
autoridad de este sistema está deliberadamente concentrada. Una puerta
la abre el Access Service con una cara delante de una cámara; un parte
lo firma quien vivió el turno. Una herramienta que pudiera hacer
cualquiera de las dos cosas por interpretación de una frase vaciaría de
sentido las dos decisiones.

La prueba de humo lo comprueba explícitamente, porque es la garantía más
fácil de romper sin querer añadiendo una herramienta útil.

## Decisión 3 — stdio, y fuera del `docker compose`

El servidor habla **stdio**: el cliente lo lanza como proceso hijo con
`node dist/index.js`.

Un contenedor con transporte HTTP habría quedado mejor en el diagrama de
arquitectura, y es más trabajo para quien lo pruebe: hay que publicar un
puerto, configurar el cliente y decidir cómo se autentica esa conexión.
Con stdio, conectarlo a Claude Code o a Claude Desktop es pegar cuatro
líneas de configuración.

Y hay un argumento de fondo: **este servidor no es parte del sistema, es
una forma de mirarlo**. Meterlo en el compose sugeriría que el control
de acceso lo necesita para funcionar, y no lo necesita para nada.

## Decisión 4 — Nada en `stdout` salvo el protocolo

El transporte de stdio usa la salida estándar para los mensajes
JSON-RPC. Un `console.log` suelto corrompe la conversación y el cliente
se desconecta **sin decir por qué**, que es de los fallos más difíciles
de diagnosticar que hay.

Por eso existe una función `aviso()` que escribe en `stderr`, y no se
usa `console` en ninguna parte del servidor.

## Lo que esto expone, dicho claro

Nombres de personas, sus horas de entrada y salida, y lo que alguien
declaró en un parte de turno. Conectar esto a un modelo es **enseñarle la
jornada de personas concretas**.

Las credenciales que consume son de administración, así que la regla
práctica es: no lo ejecutes donde no dejarías abierto el panel de
operación.

Es la segunda vez en esta fase que el proyecto cede datos a un tercero
—la primera fue la voz, en el [ADR 0011](0011-voz-e-ia.md)—, y conviene
que las dos estén escritas y no descubiertas leyendo el código.

## Lo que devuelve es texto, no JSON

Las herramientas no vuelcan la respuesta del Gateway tal cual. Devolver
el JSON crudo es lo fácil y es peor: quien lo consume es un modelo que
después se lo cuenta a una persona, y una lista de identificadores le
obliga a inventarse el significado de cada campo. Un texto que ya dice
«21 personas dentro, todas en Oficinas» se resume bien.

Dos detalles del formateo que son decisiones y no estilo:

- **`quien_esta_dentro` avisa de que «dentro» es presencia física, no
  jornada abierta.** Quien está `EN_PAUSA` salió del edificio con la
  jornada viva y no aparece. Es la distinción que sostiene toda la
  Fase 2 ([ADR 0007](0007-eventos-y-presencia.md)) y, sin decirla, un
  modelo las mezcla y afirma que alguien está en el edificio.
- **Una cita de incidencia sin respaldo sale marcada.** El Voice Service
  comprueba si el modelo pudo señalar dónde leyó cada incidencia
  ([ADR 0011](0011-voz-e-ia.md)); esa marca tiene que llegar hasta el
  final de la cadena, porque es lo único que este sistema sabe detectar
  sobre la invención de un modelo.

Ahí es donde vive casi toda la lógica del servidor, y por eso los 18
tests son de formateo. **Es la única forma en que esto puede hacer
daño:** no puede escribir nada, pero sí contar mal lo que pasó.

## Alternativas descartadas

**Un contenedor con transporte HTTP en el compose.** Ver la decisión 3.
Queda anotada como la opción a recuperar si alguna vez hace falta que
varios clientes remotos lo consulten.

**Herramientas de escritura «seguras»**, del tipo «declarar un descanso».
Cualquier lista de escrituras inofensivas crece, y la primera que se
añada convierte este servidor en algo que hay que auditar como una vía
de entrada y no como una ventana.

**Exponer los endpoints de estadísticas** (`/admin/stats/*`). Son para
dibujar un panel; un histograma de similitudes no se resume en texto sin
perder justo lo que lo hace útil, que es verlo.
