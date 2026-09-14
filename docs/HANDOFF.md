# Contexto para continuar el proyecto

Este documento está escrito para pegarlo como primer mensaje en una
sesión nueva de Claude Code. Describe qué existe, por qué está hecho
así, y hacia dónde va.

---

## Quién eres en esta conversación

Vas a continuar un proyecto ya avanzado. **Lee el README.md y los ADRs
en `docs/adr/` antes de proponer cambios de arquitectura**: muchas
decisiones que parecen mejorables ya se discutieron y tienen su motivo
documentado.

El proyecto está en `C:\Users\ASUS\Desktop\backend_detector`, en
Windows, y se ejecuta con Docker Compose.

---

## Reglas de trabajo que el usuario ya estableció

Estas no son negociables, las pidió explícitamente:

1. **Nunca hagas `git push` sin preguntarle antes.** Una autorización
   para un push no se extiende al siguiente.
2. **Trabaja siempre en rama de feature con nombre en INGLÉS**
   (`feature/algo-asi`), nunca commits directos a `main`. Él abre el PR
   y hace el merge.
3. **Ninguna atribución a Claude en los commits.** Nada de
   `Co-Authored-By`, ni `Generated with`, ni firmas equivalentes. Los
   commits van solo a su nombre.
4. Commitear en local sin preguntar sí está bien.
5. Los mensajes de commit y la documentación van **en español**; los
   nombres de rama, en inglés.

---

## Qué es el proyecto

Sistema de **control de acceso y asistencia para empresas** mediante
reconocimiento facial. Una persona se identifica con la cara frente a
una cámara, el sistema decide si puede entrar según su rol, la zona y
el horario, y registra el acceso.

Arquitectura de microservicios, funcionando de extremo a extremo.
**Fases 1, 2, 3 y 4 completadas**, más el rol en el alta, la capacidad
del Vision Service y los tests del perímetro y del frontend.
La Fase 5 (voz e IA) y la sustitución de la detección de vida están
cerradas. Lo que queda está en la sección «LO SIGUIENTE, POR ORDEN».

---

## Estado actual: qué funciona

### Servicios (5 + base de datos)

| Servicio | Stack | Responsabilidad | Puerto |
|---|---|---|---|
| `api-gateway` | NestJS 11 | Único punto de entrada. Enruta, valida, CORS, rate limiting, verifica token de admin. **Cero lógica de negocio.** | 3000 (público) |
| `services/auth-service` | NestJS + Prisma | Cuentas de administración, login argon2id | 3003 (interno) |
| `services/face-service` | NestJS + Prisma | Identidades y vectores faciales, búsqueda pgvector | 3001 (interno) |
| `services/access-service` | NestJS + Prisma | Decide el acceso: política + votación multi-frame + auditoría | 3002 (interno) |
| `services/shift-service` | NestJS + Prisma | Jornada laboral: estados de turno, línea de tiempo y horas. **Proyección**, no autoridad | 3004 (interno) |
| `services/vision-service` | Python + FastAPI | Sin estado. Píxeles → vector facial | 8000 (interno) |
| `frontend` | React 19 + Vite + Tailwind 4 | Interfaz | 5173 |
| PostgreSQL 17 + pgvector | — | Un schema y un rol por servicio | 5433 en host |
| Redis 8 | — | Bus de eventos y ventanas de votación compartidas | 6380 en host |
| `otel-collector` | OTel Contrib | Recibe la telemetría de los 6 y la reparte | interno |
| `tempo` | Grafana Tempo 3 | Almacén de trazas | interno |
| `prometheus` | Prometheus 3 | Métricas | 9090 en host |
| `grafana` | Grafana 13 | Paneles | 3001 en host |

Los cuatro últimos **no son dependencia de nadie**: no aparecen en
ningún `depends_on` de los servicios ni en ningún `/health`. Si el
Collector cae, los servicios descartan telemetría en silencio y las
puertas siguen abriendo.

**El puerto es 5433, no 5432**, porque el usuario tiene un PostgreSQL
nativo instalado ocupando el puerto estándar. Redis está en 6380 por la
misma razón.

### Modelo de datos

```
face_svc     persons, face_embeddings (vector(512), índice HNSW)
access_svc   sites, zones, access_points, roles, schedules,
             schedule_rules, role_permissions, person_roles,
             access_logs, access_sessions,
             presence, outbox_events
auth_svc     admin_users
shift_svc    work_days, timeline_entries
```

Tres índices parciales sostienen **invariantes**, no rendimiento: la
cola pendiente de la outbox, "una sola jornada abierta por persona", y
`source_event_id` único, que es lo que hace idempotente al consumidor.
Prisma no sabe expresarlos, así que viven solo en las migraciones.

### Pipeline de reconocimiento (verificado con mediciones reales)

```
frame JPEG
  → rostros.pt (YOLOv8s, 1 clase 'rostro')     detección
  → 2d106det (InsightFace)                      landmarks
  → alineación por 5 puntos → 112x112
  → ArcFace w600k_r50                           vector 512-d, norma L2
  → pgvector <=> (coseno)                       búsqueda
  → umbral 0.38
  → votación 3 de 5 frames
  → política: rol + zona + horario
  → acceso concedido
```

**Datos medidos, no estimados:** misma persona 0.49–0.99 de similitud,
personas distintas −0.08–0.24. El mapeo de landmarks 106→5
(`[33, 96, 86, 65, 61]`) se derivó empíricamente comparando contra los
puntos nativos de SCRFD, no de documentación.

### Interfaz (Fase 3)

- **`/home`** tras identificarse: estado de turno, hora de entrada,
  horas trabajadas y de descanso, y la línea de tiempo del día. Se lee
  con el token de sesión facial; el identificador de la persona no
  viaja en la petición, lo deduce el Gateway del token.
- **`/admin/dashboard`**: aforo, actividad reciente, denegaciones por
  motivo, distribución de similitudes y mapa de actividad por hora.
  Exige cuenta de administración porque muestra datos de terceros.
- Tres endpoints de estadísticas nuevos en el Access Service, agregados
  en SQL.
- **Descansos declarados por la persona**: baño, café o almuerzo no
  cruzan ningún lector, y sin poder declararlos la jornada contaría
  como trabajado todo el rato dentro del edificio. `POST
  /me/shift/break` y `/me/shift/resume`.
- **`/admin/faces`**: el alta es un asistente de datos → rol → rostro, y
  la lista marca a quien le falte un paso. El listado es el único sitio
  donde el Gateway compone dos servicios (identidad del Face Service,
  rol del Access Service), con plazo propio de 2 s y degradación a
  `roles: null` si el Access Service no responde.

**Restricciones del panel que NO hay que romper.** Ocupa exactamente el
alto de la ventana y no crece: tres columnas que desbordan *por dentro*
si les hace falta. Un panel de operación que obliga a bajar es un panel
cuya mitad inferior no mira nadie, y ahí estaban precisamente los dos
análisis. Si añades un bloque, va dentro de una columna, no debajo.

**Lo que un botón NO puede hacer.** Declarar un descanso sí; fichar la
entrada o la salida, nunca. Eso lo decide el Access Service con una
cara delante de una cámara, y un botón que abriera jornada convertiría
el control de acceso en un adorno. Quien está `EN_PAUSA` —fuera del
edificio— tampoco puede declarar nada: su vuelta la registra la puerta.

**El hallazgo de esta fase.** El análisis del umbral con datos reales
da **0.0641** de separación entre nubes, frente al 0.2552 que midió el
ADR 0003 sobre fotos de archivo. Cuatro veces menos margen. Y el
camino hasta ese número también importa: la primera versión contaba
falsos rechazos y falsas aceptaciones, y salían cero siempre porque
las dos nubes las separa el propio umbral que se evalúa. Está
explicado en `threshold.analysis.ts`; **no lo "arregles" volviendo a
contar tasas de error**.

### Presencia y jornada (Fase 2)

La decisión central: **el estado que gobierna una puerta no puede ser
eventualmente consistente.** Por eso el dominio está partido en dos.

| | Dueño | Qué es | Consistencia |
|---|---|---|---|
| Presencia física | `access_svc` | Dentro o fuera de una zona | **Fuerte**: misma transacción que la concesión |
| Estado laboral | `shift_svc` | En turno, de descanso, horas | Eventual: proyectada de los eventos |

No es duplicación: son dos preguntas distintas. Una hoja de horas puede
ir un segundo por detrás; una cerradura, no.

- **Anti-passback** con tres modos por zona (`HARD`/`SOFT`/`OFF`) y una
  ventana de gracia de 10 s. El defecto es `SOFT` porque al desplegar
  nadie ha "entrado" todavía según el sistema.
- **Estados de turno**: `FUERA`, `EN_TURNO`, `EN_DESCANSO`, `EN_PAUSA`.
  `EN_PAUSA` es **provisional**: salir no cierra la jornada, porque en
  ese momento no se puede saber si la persona volverá. Un reconciliador
  la convierte en cierre pasado el tiempo, con la hora de la salida.
- **Outbox transaccional** + Redis Streams. Entrega "al menos una vez",
  idempotencia por `eventId`. Un evento perdido serían horas no
  computadas de alguien.
- **Ventanas de votación en Redis**, con degradación a memoria si Redis
  no responde. La dirección del fallo es segura: sin estado compartido
  cuesta más entrar, nunca menos.

### Seguridad implementada

- argon2id con parámetros OWASP, verificación contra hash de descarte
  para que el tiempo de respuesta no delate si una cuenta existe
- Bloqueo tras 5 intentos + rate limiting por IP
- Los tokens llevan `typ` (`admin` vs `access-session`) y el guard lo
  comprueba: un token de acceso facial NO sirve para administrar
- Los embeddings nunca salen del backend (garantizado por el tipo
  `Unsupported` de Prisma, no por disciplina)
- No se guarda ninguna imagen facial, solo el vector
- Aislamiento por rol de PostgreSQL: `face_svc_user` no puede leer
  `auth_svc` aunque su código lo intentara
- El terminal identifica la puerta con una `terminal_key` que él envía;
  no la elige quien entra

### Verificación

```bash
node scripts/smoke-test.mjs --enroll a1.jpg --verify a2.jpg --stranger b.jpg
# 22 comprobaciones end-to-end contra el stack real

node scripts/ci-local.mjs             # reproduce el CI completo en local
node scripts/assign-role.mjs          # ver y asignar roles
node scripts/apply-shift-schema.mjs   # crea shift_svc en una BD ya existente
```

CI en GitHub Actions: tipos, compilación y tests de los 5 servicios
Node, sintaxis del vision-service, y verificación de que no hay `.env`
versionado. El paso de tests se salta solo en los servicios que no
declaran un script `test`, así que añadir uno basta para que entre.

Para comprobar la observabilidad hace falta el stack levantado y algo de
tráfico. La prueba de humo sirve de generador: cada pasada produce una
traza completa que cruza el bus. Después:

```bash
# ¿Qué servicios ve Tempo?
docker compose exec prometheus wget -qO-   http://tempo:3200/api/search/tag/service.name/values

# Una traza concreta, por su identificador
docker compose exec postgres psql -U facedetector -d face_access -t   -c "select trace_context from access_svc.outbox_events
      where trace_context is not null order by created_at desc limit 1;"
```

El `trace_context` de la fila lleva el identificador de la traza entre
los dos primeros guiones.

---

## Limitaciones conocidas y asumidas

Están documentadas en el README; **no las "descubras" como si fueran
fallos**:

1. **Detección de vida MEDIDA, pero contra un solo tipo de ataque.**
   Desde el 2026-09-14 la decide **MiniFASNet**, y la señal espectral
   que había antes está retirada porque se midió y no separaba.

   El Vision Service devuelve `spoofScore` —probabilidad de cara real—
   y el Access Service decide con `LIVENESS_MIN_SPOOF_SCORE` (0.60).
   Medido sobre 40 caras reales y 38 fotos de esas caras en la pantalla
   de un móvil, variante de 640 px, **sin ajustar nada**:

       cara real   0.9851 ± 0.0399   peor caso 0.7769
       pantalla    0.1187 ± 0.1517   mejor caso 0.5388
       APCER 0.0 %   BPCER 0.0 %   9.2 ms de mediana

   Y el corte elegido usando solo la primera tanda de captura, aplicado
   a las que no participaron en elegirlo, también da 0 % y 0 %.

   **Por defecto SIGUE SIN DENEGAR** (`SOFT`: anota en
   `acceso_sospechas_de_vida` y deja pasar), y el motivo ha cambiado. Ya
   no es que falte medir: falta **cobertura**. El conjunto es de una
   persona y un móvil, sin foto impresa, sin vídeo en pantalla, sin
   máscara y sin una segunda cara.

   El sistema sigue **sin ser apto para control de acceso real**, ahora
   por un motivo más estrecho: su defensa está validada contra **un**
   tipo de ataque y no se ha probado contra los demás. Los números y lo
   que haría falta para encender `HARD` están en el
   [ADR 0014](adr/0014-modelo-de-deteccion-de-vida.md); el
   [ADR 0010](adr/0010-deteccion-de-vida.md) conserva la estructura de
   la decisión y la autopsia de la señal retirada.

2. **Cobertura de tests desigual, pero ya no en el perímetro.** Hay
   **298 casos**, recontados ejecutándolos el 2026-09-14:

   | Servicio | Casos | Qué cubre |
   |---|---|---|
   | `access-service` | 104 | Política, votación, anti-passback, umbral, outbox, contrato del evento, detección de vida |
   | `frontend` | 73 | Reglas de `/home` y los tres estados del rol |
   | `shift-service` | 44 | Máquina de turnos, parser del bus, contexto de traza |
   | `api-gateway` | 26 | Los dos guards: la exclusión entre administrar y estar reconocido |
   | `vision-service` | 18 | Aritmética del medidor de vida: veredicto, cortes y mitad reservada |
   | `auth-service` | 17 | Login, bloqueo por intentos, igualación de tiempos |
   | `logbook-service` | 16 | Firma, inmutabilidad y cruce congelado de la bitácora |

   Todas son funciones puras o con dobles, así que corren en segundos y
   sin contenedores.

   **Fuera de esa cuenta** quedan los que necesitan algo instalado:
   `services/vision-service/tests/test_spoof.py` (8 casos) pide torch y
   los pesos y se ejecuta dentro del contenedor; los del
   `voice-service` piden `httpx` y corren en el CI. `mcp-server` tiene
   los suyos con su propio runner.

   El **frontend** tiene ya 33 casos con vitest y testing-library, y
   corren en el CI. Cubren las reglas, no los estilos: qué controles
   existe en cada estado de turno y los tres estados del rol en el
   listado. La cobertura global ronda el 17 %: se empezó por donde una
   regresión silenciosa cuesta caro, no por subir un porcentaje. Lo que
   queda sin tocar es el panel de operación, el asistente de alta y la
   captura de cámara.

   `face-service` tampoco tiene tests propios. Su garantía crítica —que
   los embeddings no salgan del backend— la impone el tipo
   `Unsupported` de Prisma, no la disciplina, así que la ausencia pesa
   menos de lo que parece.

   Lo que **sigue sin tests unitarios** es el pipeline de reconocimiento
   y el enrolamiento, que necesitan imágenes y modelos reales. La prueba
   de humo los cubre de extremo a extremo.

3. **Sin revocación de tokens.** Uno robado vale hasta caducar (8 h).
4. ~~Estado de votación en memoria~~ **resuelto**: las ventanas se
   comparten en Redis. Lo que no escala ahora es el consumidor del
   shift-service: con varios, los eventos de una persona podrían
   procesarse a destiempo (la máquina descarta lo desordenado, así que
   perdería transiciones y no las corrompería). Desde la Fase 4 al menos
   **se ve**: `shift_consumidor_pendientes` mide el retraso del grupo.
5. **El umbral 0.38 va ajustado.** Ya está medido con datos reales: la
   separación entre nubes es 0.0641 y no el 0.2552 de las fotos de
   archivo. El panel lo muestra. Lo que hace falta no es cambiar el
   número, es mejorar la captura.
6. **Las migraciones se escriben a mano** a propósito: no crean schemas
   ni extensiones (eso lo hace el init de PostgreSQL como superusuario),
   lo que impide que Prisma use su base de datos sombra. Está explicado
   en `.github/CONTRIBUTING.md`. Hay una segunda razón desde la Fase 2:
   Prisma tampoco sabe expresar índices parciales, y tres invariantes
   del sistema dependen de ellos.

7. **Redis sin alta disponibilidad.** Una instancia, sin réplica.
   Aceptable porque ninguna de sus dos funciones puede dejar a nadie
   fuera de un edificio.

8. **Una ventana de ~1 s en el anti-passback** entre leer la presencia y
   escribirla, porque en medio ocurre la votación. Solo explotable con
   una fotografía en una segunda puerta, es decir, solo mientras siga
   pendiente el anti-spoofing.

---

## Hacia dónde va

El objetivo del usuario es **llevarlo a algo publicable en LinkedIn** y
que demuestre nivel senior. El producto elegido es control de acceso y
asistencia empresarial.

Plan acordado, en orden:

### ~~Fase 2 — Presencia y turnos~~ · HECHA

Todo lo previsto, más el detalle de dónde vive la presencia, que era la
decisión de fondo. Ver [ADR 0007](adr/0007-eventos-y-presencia.md).

### ~~Fase 3 — Home y Dashboard~~ · HECHA

Todo lo previsto. El feed es por sondeo cada cinco segundos y no un
flujo en vivo: un stream obligaría al Gateway a mantener una conexión
abierta por pestaña, y cinco segundos no cambian ninguna decisión en un
panel que se mira de reojo.

Sin librería de gráficos: el histograma son barras y el mapa de calor
una cuadrícula, y tematizar Recharts para el cristal esmerilado era más
código que dibujarlos.

### ~~Asignar el rol en el alta~~ · HECHA

El alta es ahora un asistente de tres pasos —datos → rol → rostro— y la
lista marca a quien le falte alguno, con un botón que lleva al paso que
falta. Está explicado en el README.

**Corrección de cifras, porque el dato que había aquí engañaba.** Este
documento decía «12 personas y solo 6 con rol». Las 12 salían de contar
la tabla entera, y el borrado de personas es **lógico**: deja una lápida
con `deleted_at` y `status = SUSPENDED` porque los registros de
auditoría apuntan a esas filas. De las 12, ocho eran lápidas de pruebas
de humo. El recuento real de personas vivas era **5, de las cuales 1 sin
rol**. El agujero era verdadero, pero cuatro veces más pequeño de lo que
decía el documento. Al contar filas de esta base de datos, filtra por
`deleted_at IS NULL`.

Lo que sigue sin cerrarse, y es deliberado: **por API todavía se puede
crear a alguien sin rol.** Cerrarlo en el servidor obligaría al Face
Service a llamar al Access Service, invirtiendo la única dirección de
dependencia que hoy está limpia. Lo exige el asistente, no el servidor.

### ~~Fase 4 — Observabilidad~~ · HECHA

Los seis servicios instrumentados con OpenTelemetry, un Collector en
medio, Tempo, Prometheus y Grafana. Todo lo previsto, incluida la traza
que cruza el bus. Ver [ADR 0009](adr/0009-observabilidad-con-opentelemetry.md).

**El hallazgo de esta fase.** Ya se sabe dónde se va el tiempo de un
frame (p95, medido sobre el stack real):

| Etapa | p95 | |
|---|---|---|
| Petición completa | ~1 s | |
| `vision.detect` | ~740 ms | **el cuello de botella** |
| `vision.embed` | ~450 ms | |
| `vision.align` | ~31 ms | |
| pgvector | ~1.2 ms | no interviene |

El coste está en el **detector**, no en el embedding, y la búsqueda
vectorial —la sospechosa intuitiva— cuesta algo más de un milisegundo.
Son contenedores sin GPU en un portátil: vale la proporción, no el
valor absoluto.

**Dos cosas que no hay que "arreglar".**

1. **El hueco de ~450 ms en medio de la traza no es latencia**, es el
   intervalo de sondeo del relay. El evento ya está confirmado en
   PostgreSQL esperando a que lo recojan, que es lo que la outbox
   promete.
2. **Los bucles de fondo no se trazan a propósito** —el relay, la
   espera del consumidor, los medidores, las sondas de salud—. Sin
   suprimirlos serían más de cien mil trazas diarias diciendo «no había
   nada». Si añades un temporizador, súmalo a esa lista.

**El error que costó encontrar**, por si reaparece: el span de
publicación del relay heredaba la supresión de trazado del sondeo,
porque se derivaba del contexto activo. Nacía sin registrar y el tramo
asíncrono no salía en ninguna traza, sin ningún error por ningún sitio.
Se extrae desde `ROOT_CONTEXT`.

### ~~Pruebas del frontend~~ · HECHA

Infraestructura con vitest, jsdom y testing-library —no había ninguna— y
33 casos. **Corren en el CI**: hubo que añadir el paso, porque el
frontend solo comprobaba tipos y compilación, y unos tests que no se
ejecutan son decoración.

**No se comprueba ni una clase de Tailwind.** Los estilos cambian con
cada ajuste de diseño, y una suite que se rompe al mover un margen es
una suite que nadie vuelve a ejecutar. Lo que se fija son las reglas que
la interfaz representa, y dos no están escritas en ningún servicio: qué
puede hacer un botón —declarar un descanso sí, fichar jamás, y quien
está `EN_PAUSA` nada porque está fuera del edificio— y los tres estados
del rol en el listado, donde `null` es «no se pudo preguntar» y `[]` es
«no tiene ninguno».

Se verificaron rompiéndolos, igual que los del perímetro.

**Un cambio pequeño en producción, justificado por sí mismo:** el
listado de personas pasa a ser un `<ul>` de verdad, con `GlassCard`
aceptando la etiqueta a renderizar. Una lista de personas es una lista;
el lector de pantalla anuncia cuántas hay, y la línea de tiempo de
`/home` ya usaba `<ol>` por lo mismo. De paso hace las fichas acotables
en un test sin depender de la posición.

**Si escribes más tests aquí, cuidado con los nombres de los fixtures.**
Dos de los míos fallaron por eso y no por el producto: una persona
llamada «Sin Rol» choca con la insignia «Sin rol», y un punto de acceso
llamado «Entrada Principal» choca con la etiqueta «Entrada» de la línea
de tiempo.

### LO SIGUIENTE, POR ORDEN

**1. ~~Fase 5, voz e IA~~ · COMPLETA.** `voice-service`,
`logbook-service`, servidor MCP e interfaz, verificados contra el stack.
Detalle abajo.

**2. ~~Sustituir la señal de detección de vida~~ · HECHO.** Se reunió
el conjunto de ataque (`scripts/capture-attack-set.mjs`), se midió
(`scripts/measure-liveness.mjs`), la señal espectral quedó refutada y
está sustituida por MiniFASNet. Ver
[ADR 0014](adr/0014-modelo-de-deteccion-de-vida.md).

**3. Ampliar el conjunto de ataque**, que es lo que queda para poder
encender `LIVENESS_MODE=HARD`. Faltan foto impresa, vídeo reproducido
en pantalla, más de una persona y otra cámara. Mientras no estén, `HARD`
no se enciende: lo medido cubre un solo tipo de ataque.

### Fase 5 — Voz e IA · EL `voice-service` YA ESTA

**Hecho y verificado contra el stack real:** el `voice-service` (Python,
sin estado, simétrico al vision-service). Audio → Deepgram → Gemini →
estructura, con los dos proveedores reales. Ver
[ADR 0011](adr/0011-voz-e-ia.md).

Medido de extremo a extremo con 37.7 s de audio en español:

    transcribir .....  1.4 - 3.6 s   (nova-3)
    estructurar .....  1.8 - 6.0 s   (gemini-3.8-flash)
    4 incidencias, las 4 con cita respaldada

**Lo que hay que entender de este servicio**, porque condiciona lo que
venga después:

1. **Lo que devuelve es un BORRADOR, no un registro.** Nada se guarda
   hasta que la persona que vivió el turno lo confirma. Un parte de
   relevo no tiene regla mecánica que aplicar: es un testimonio, y es
   el documento que se lee cuando algo ha salido mal.
2. **La defensa contra la invención es una comprobación, no una
   instrucción.** Al modelo se le exige una cita literal por incidencia
   y el servicio comprueba que existe en la transcripción
   (`app/services/citas.py`, 16 tests **que sí corren en el CI** porque
   solo usan la biblioteca estándar). Una cita que no cuadra **se marca,
   no se borra**. El recuento va a la traza como
   `voice.incidents.unbacked`.
3. **Rompe la promesa de privacidad del proyecto, y hay que decirlo.**
   Es el único punto donde un dato biométrico sale del backend: la voz.
   El audio no se guarda en ningún sitio y las trazas solo llevan
   métricas, pero «ningún dato biométrico sale» deja de ser cierto.
4. **Decisiones medidas, no copiadas de una documentación.** `nova-3`
   frente a `nova-2`: 1955 ms contra 8308 ms por una transcripción
   idéntica. Y `smart_format` **apagado**, porque convierte «las tres y
   cuarto» en «las 3 y 4º» y en un parte de turno la hora es el dato por
   el que alguien vuelve a leerlo.
5. **Modelo con versión fija y temperatura cero.** Nada de
   `gemini-flash-latest`: un alias cambia de modelo por debajo y con él
   cambiarían las incidencias que salen del mismo parte.

**Si api.deepgram.com no resuelve, no es el código.** Hay routers
domésticos que devuelven respuesta vacía para ese nombre concreto
mientras resuelven todo lo demás. Arréglalo poniendo un DNS que funcione
en el HOST; el `docker-compose.yml` lleva una línea `dns:` comentada
para parchearlo solo en este servicio. Es el único servicio del sistema
que necesita salir a Internet.

### El `logbook-service` también está · HECHO

Dueño de la bitácora, con schema y rol propios (`logbook_svc`). Ver
[ADR 0012](adr/0012-bitacora-de-relevo.md).

**Verificado contra el stack real**, firmando un parte por el Gateway
con un token de sesión: el nombre de la sede lo trae del Access Service
(no del cuerpo), el día se imputa en hora local de Bogotá, y el cruce de
accesos quedó congelado dentro —266 intentos, 9 concedidos, 257
denegados, con `BELOW_THRESHOLD` 252 y `LIVENESS_FAILED` 1—.

**Las siete decisiones que no hay que deshacer:**

1. **Aquí solo entra lo FIRMADO.** No hay borradores en la base de
   datos. El borrador vive en el cliente entre dictarlo y firmarlo.
2. **Inmutable.** No hay `PUT`, ni `PATCH`, ni `DELETE`, ni en el
   servicio ni en el Gateway. Una corrección es un parte nuevo que
   apunta al anterior con `correctsEntryId`, y los dos quedan.
3. **Firma quien vivió el turno.** `personId` sale del token y viaja en
   cabecera; el esquema de entrada **no tiene** campo para la persona, y
   hay un test que lo fija. La vista de administración es de **solo
   lectura**.
4. **El cruce de accesos se congela al firmar.** No se compone al leer:
   un parte es evidencia de lo que se sabía entonces.
5. **Sin Access Service se firma igual** (probado parando el
   contenedor): `accessSnapshot` y `siteName` a nulo, día calculado en
   UTC, y aviso en el log. Por eso el `depends_on` es `service_started`.
6. **Cada incidencia dice de dónde salió** —aceptada, editada o añadida
   a mano—. Es lo que permitirá responder con datos si el modelo sirve
   de algo.
7. **La hora se guarda tal y como se dijo** («las tres y cuarto»), sin
   normalizar.

16 tests de lógica pura, verificados con cinco mutaciones que cada una
tumba exactamente un caso.

### El servidor MCP también está · HECHO

`services/mcp-server`, por stdio y **fuera del compose**. Tres
herramientas: `quien_esta_dentro`, `horas_trabajadas` y
`novedades_de_turno`. Ver [ADR 0013](adr/0013-servidor-mcp.md) y el
[README del paquete](../services/mcp-server/README.md).

**Lo que no hay que deshacer:**

1. **Es cliente del GATEWAY, no de la base de datos.** Se autentica con
   una cuenta de administración y pasa por los mismos guards que el
   navegador. Ir directo a PostgreSQL sería más rápido y abriría una
   segunda puerta que nadie vigila, además de saltarse el aislamiento
   por roles.
2. **Solo lectura, y anunciado con `readOnlyHint`.** Ninguna herramienta
   abre una puerta, firma un parte ni toca una jornada. La prueba de
   humo lo comprueba, porque es la garantía más fácil de romper sin
   querer añadiendo una herramienta útil.
3. **Nada en `stdout` salvo el protocolo.** stdio usa la salida estándar
   para el JSON-RPC: un `console.log` suelto corrompe la conversación y
   el cliente se desconecta sin decir por qué. Los avisos van por
   `stderr`, con la función `aviso()`.
4. **Devuelve TEXTO, no JSON crudo.** Lo consume un modelo que se lo
   cuenta a una persona. Ahí vive casi toda la lógica, y por eso los 18
   tests son de formateo: este servidor no puede escribir nada, pero sí
   contar mal lo que pasó.
5. **`quien_esta_dentro` avisa en su respuesta de que «dentro» es
   presencia física y no jornada abierta.** Sin esa nota, un modelo las
   mezcla y afirma que alguien está en el edificio cuando está
   `EN_PAUSA`.

**Verificado contra el stack real:** `npm run smoke`, 9 comprobaciones
en verde, hablando el protocolo por stdio con el cliente oficial del
SDK. Devolvió 21 personas dentro, 21 jornadas abiertas y las 2
incidencias pendientes del parte firmado.

    cd services/mcp-server && npm ci && npm run build && npm run smoke

### La interfaz también está · FASE 5 COMPLETA

`/relevo` para dictar, revisar y firmar; y en `/home`, lo que dejó
pendiente el turno anterior nada más identificarse.

**Cuatro reglas viven solo en el frontend**, y tienen tests:

1. **Sin jornada abierta no se firma.** De ahí sale el `siteId` y el
   inicio del periodo. Para esto se añadió `siteId` a `/me/shift`: el
   terminal conoce su puerta, no su sede.
2. **Se llega al final sin micrófono y sin modelo.** Sin transcripción
   se escribe a mano; sin estructurador queda la transcripción y las
   incidencias se añaden a mano.
3. **Una cita sin respaldo se ve ANTES de firmar.**
4. **Cada incidencia declara de dónde salió** —aceptada, corregida o
   añadida a mano—. Solo el cliente lo sabe.

La lógica está en `frontend/src/lib/handover.ts`, aparte del JSX para
poder probarla sin simular un micrófono. 35 casos nuevos; el frontend
pasa de 33 a 68.

**Lo que la verificación por mutación destapó, y conviene saber.** Dos
de esos tests afirmaban más de lo que comprobaban: uno decía cubrir una
copia defensiva que **no hacía ningún trabajo** —el spread de al lado ya
copiaba—, y otro daba por probado un invariante que pasaba por
casualidad. Están corregidos, y el comentario que explicaba la
protección inexistente también. Si añades tests aquí, rómpelos antes de
creerlos.

**La transcripción no se edita, a propósito.** El resumen y las
incidencias sí. El texto es lo que se dijo y es lo que zanja una
discusión; la estructura es una interpretación.

**FASE 5 COMPLETA.** El paso 2 —sustituir la señal de detección de
vida— también está cerrado; la autopsia de la señal vieja y lo que la
reemplaza vienen a continuación.

### LA SEÑAL ESPECTRAL NO FUNCIONABA — y ya está sustituida

> **Resuelto el 2026-09-14.** Lo decide ahora MiniFASNet
> ([ADR 0014](adr/0014-modelo-de-deteccion-de-vida.md)), que sobre el
> conjunto de ataque da APCER 0.0 % y BPCER 0.0 % sin haber ajustado
> nada, y aguanta fuera de la tanda que eligió el corte.
>
> **Esta sección se conserva entera** porque el diagnóstico sigue
> valiendo: explica por qué una señal pasiva no puede medirse sobre el
> recorte de 112, que es la razón de que la nueva se mida sobre el frame
> original. Lo que abajo aparece como pendiente está cumplido.

**2026-09-13.** Se midieron dos pruebas consecutivas con la misma webcam
y la misma persona: primero su cara real, después una foto de su cara en
la pantalla del móvil. Las dos entraron. Estos son los números que midió
el Vision Service, sacados de las trazas:

| | detalle fino | pico periódico |
|---|---|---|
| **Cara real** (3 frames) | 0.3819 – 0.4431 | **24.8 – 43.6** |
| **Móvil** (4 frames) | 0.3571 – 0.4417 | **23.7 – 28.9** |
| Móvil, sesión anterior (3 frames) | 0.4503 – 0.4816 | 21.8 – 26.7 |

Medias: detalle 0.403 (real) frente a 0.407 (móvil). Pico **34.1**
(real) frente a **25.0** (móvil).

**LAS DOS SEÑALES APUNTAN AL REVES.**

- El **pico periódico** existe para delatar la rejilla de una pantalla.
  Marcó MAS ALTO con la cara real (hasta 43.6) que con el móvil (nunca
  pasó de 28.9).
- El **detalle fino** debía caer con una recaptura. Da prácticamente lo
  mismo en ambos casos, y si acaso ligeramente más alto en el móvil.

**No es un problema de umbral.** Cualquier umbral que atrapara el móvil
rechazaría antes una cara real. Esto no se calibra: se retira o se
sustituye.

**Por qué falla, y es estructural, no mala suerte.** La señal se mide
sobre el recorte alineado de 112x112, y entre el sensor y ese recorte
hay **dos reducciones sin filtro antialias**: el terminal manda 640 px
de ancho (`useCamera.captureFrame`, 640 y calidad 0.75) y `norm_crop`
remuestrea a 112 con un `warpAffine` bilineal. Una rejilla de píxeles no
sobrevive a eso: se pierde, o se pliega por aliasing a una frecuencia
cualquiera. A eso se suma que una pantalla moderna a la distancia de uso
ya está en el límite de lo que resuelve una webcam de 720p.

Y `pattern_peak`, siendo `max/mediana` de la banda alta, mide de hecho
**si la banda alta tiene estructura destacada**, no si hay periodicidad.
Una cara real de frente la tiene —pelo, bordes, textura de piel—; una
foto en pantalla llega más suave. Por eso el signo sale invertido de
forma consistente, y no por ruido.

Las degradaciones sintéticas del ADR 0010 reaccionaban porque la rejilla
se aplicaba píxel a píxel **sobre la imagen ya reducida**, que es algo
que no le pasa a ninguna foto de ninguna pantalla.

**Consecuencia para lo que venga:** cualquier señal pasiva que dependa
de la textura **no puede medirse sobre el recorte de 112**, y
probablemente tampoco sobre el frame de 640 que el terminal envía hoy.
Sustituir la señal ya no es solo cambiar `liveness.py`: es decidir
también qué imagen llega hasta ahí.

**QUE SE HIZO CON ESTO**, en el orden en que estaba escrito:

1. ~~NO tocar los umbrales.~~ Los dos umbrales espectrales están
   **retirados**: `LIVENESS_MIN_DETAIL_RATIO` y
   `LIVENESS_MAX_PATTERN_PEAK` ya no existen. En su lugar hay uno solo,
   `LIVENESS_MIN_SPOOF_SCORE=0.60`, y ese sí sale de una medida.
2. **`LIVENESS_MODE=HARD` SIGUE SIN ENCENDERSE**, y este punto no ha
   caducado. El motivo ha cambiado —ya no es que la señal esté sin
   medir, es que solo se ha probado contra un tipo de ataque— pero la
   conclusión es la misma: el defecto es `SOFT`.
3. ~~Decidir entre retirar la señal espectral o sustituirla.~~ Se
   sustituyó, por MiniFASNet. El reto activo sigue anotado como la
   opción a recuperar si la vía pasiva no basta.
4. **La herramienta para reunir el conjunto**, que fue lo que destrabó
   todo lo demás:

   ```bash
   node scripts/capture-attack-set.mjs      # abre http://localhost:5174
   ```

   Abre una página, usa la misma webcam y **los mismos parámetros de
   captura que el terminal** —copiados de `useCamera.ts`, porque un
   conjunto grabado por otra ruta mide una cámara que este sistema no
   usa—, y guarda las dos clases en `datasets/liveness/`, que el
   `.gitignore` excluye entero: son rostros reales y el script se niega
   a arrancar si git no lo confirma.

   De cada disparo guarda **dos variantes**: `terminal` (640 px, calidad
   0.75, lo único que el sistema ve hoy) y `nativo` (el frame completo a
   0.95). La segunda existe por el hallazgo de arriba: si la señal
   sustituta necesita más píxeles, habría que repetir la sesión entera,
   y el tiempo de alguien posando delante de una cámara es el recurso
   caro de todo esto.

   **Y el medidor también está**, que era la otra mitad:

   ```bash
   node scripts/measure-liveness.mjs
   ```

   Pasa cada imagen por el Vision Service —reutilizando los modelos ya
   cargados— y responde UNA pregunta: si existe algún umbral sobre las
   señales actuales que separe las dos clases. Mide las **dos
   variantes**, `terminal` y `nativo`, porque si separase solo en la
   nativa la conclusión no sería «la señal sirve» sino «habría que
   cambiar lo que el terminal envía», y eso tiene un coste que hay que
   conocer antes de decidirlo.

   Devuelve el veredicto en el código de salida: `0` separa, `1` no
   separa, `2` no se pudo medir.

   **Lee esto antes de fiarte del resultado.** La primera versión
   declaraba «la señal separa» cuando el detector no había encontrado
   NINGUNA cara: no hallaba indicios de lo contrario y lo tomaba por
   bueno. Un medidor que declara éxito habiendo medido nada es peor que
   uno que falla, porque el número que da no es optimista, es inventado.
   Está arreglado y hay 18 tests que lo fijan —verificados rompiéndolos,
   las cuatro mutaciones caen—, pero si tocas ese script, esa es la
   trampa.

   **Y ahora hace una cosa más**: parte el conjunto por tanda de
   captura, elige el corte en la primera y lo aplica a las demás. Es la
   comprobación que cazó el error de la señal vieja —0 % de error dentro
   de su tanda, APCER 25 % y BPCER 20 % fuera— y vive dentro de la
   herramienta justo para que no dependa de que alguien se acuerde de
   hacerla.

**Lo que esto NO invalidó.** El andamiaje, que era lo caro: la evidencia
viaja del Vision Service a la decisión, `HARD` deniega con
`LIVENESS_FAILED`, y `SOFT` con la misma sospecha deja pasar. Sustituir
la señal fue añadir `app/recognition/spoof.py` y cambiar un umbral; no
hubo que rehacer nada de la estructura.

### ~~Fase 6 — Anti-spoofing~~ · HECHA, y ahora también medida

Detección de vida pasiva: el Vision Service mide, el Access Service
decide, y los modos son `OFF`/`SOFT`/`HARD` como el anti-passback. Esa
estructura es del [ADR 0010](adr/0010-deteccion-de-vida.md) y no ha
cambiado.

Lo que sí cambió es **quién mide**. Hoy es MiniFASNet, sobre el frame
original y no sobre el recorte alineado, por 9.2 ms de mediana. La señal
espectral anterior se retiró después de medirla contra un ataque real.
Todo en el [ADR 0014](adr/0014-modelo-de-deteccion-de-vida.md).

**LO QUE SE PUEDE DECIR, Y LO QUE NO.** Se puede decir que sobre 40
caras reales y 38 fotos en la pantalla de un móvil, con la cámara del
despliegue, no hubo ni un fallo en ninguno de los dos sentidos, y que el
corte elegido en una tanda aguanta en las siguientes.

**No se puede decir que el sistema detecta fotos.** No se ha probado
contra foto impresa, ni contra vídeo reproducido en pantalla, ni con más
de una persona, ni con otra cámara. Por eso el defecto sigue siendo
`SOFT`, y por eso el README sigue diciendo que el sistema no es apto
para control de acceso real.

**Si retomas esto, empieza por aquí:** graba los ataques que faltan con
`node scripts/capture-attack-set.mjs` y vuelve a pasar
`node scripts/measure-liveness.mjs`. Es lo único que queda entre el
estado actual y poder encender `HARD`, y hay que hacerlo **por zona**,
no globalmente.

Una advertencia que salió al probar el modelo y conviene no olvidar:
alimentado con **ruido puro** devuelve 0.97 de «cara real». No es un
validador de rostros —da por hecho que hay una cara porque el detector
ya la encontró— y su número no significa nada fuera de ese contexto.

