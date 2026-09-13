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
**Fases 1, 2, 3 y 4 completadas**, más el rol en el alta de la persona.
Lo siguiente está en la sección «LO SIGUIENTE, POR ORDEN»: las pruebas
del frontend y después la Fase 5 (voz e IA).

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
versionado.

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

1. **Sin anti-spoofing.** Una foto en un móvil pasaría la
   autenticación. El sistema no es apto para producción real.
2. **Cobertura de tests desigual.** Hay 132 tests sobre las piezas que
   deciden o afirman algo: política de acceso (31), votación (12),
   anti-passback (19), análisis del umbral (13), contrato del evento
   (9), relay de la outbox (8), máquina de turnos (33) y parser del
   evento (7). Todas son funciones puras o con dobles, así que corren
   en segundos y sin contenedores.

   **El frontend no tiene ninguna prueba.** Es la brecha más visible
   ahora que hay dos pantallas con lógica de presentación real.

   Lo que **sigue sin tests** es el pipeline de reconocimiento y el
   enrolamiento, que necesitan imágenes y modelos reales. La prueba de
   humo los cubre de extremo a extremo, pero no como test unitario.
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

### LO SIGUIENTE, POR ORDEN

**1. Pruebas del frontend.** Cero ahora mismo, y ya hay tres pantallas
con lógica de presentación real (la máquina de estados pintada en
`/home`, las traducciones exhaustivas de motivos en el panel, y ahora
el asistente de alta con sus tres pasos y sus estados incompletos).

**2. Fase 5, voz e IA.** Descrita más abajo, sin cambios.

### Fase 5 — Voz e IA
- `voice-service` (Python, sin estado, simétrico al vision-service):
  audio → Deepgram → Gemini → estructura
- Caso de uso real: **bitácora de relevo de turno**. Un vigilante dicta
  las novedades, el sistema las estructura en incidencias y las cruza
  con los registros de acceso de esa franja horaria
- El audio se transcribe y **se descarta**, igual que las imágenes
  faciales: coherencia con la política de privacidad existente
- **Servidor MCP** que expone el dominio como herramientas
  (`quien_esta_dentro`, `horas_trabajadas`, `novedades_de_turno`)
- Las claves de Deepgram y Gemini están en el `.env` del usuario

### Fase 6 — Anti-spoofing
Detección de vida. El punto de enganche es la votación multi-frame, que
ya acumula frames consecutivos.

---

## Cómo levantar el proyecto

```bash
docker compose up -d
# Frontend      http://localhost:5173
# Swagger       http://localhost:3000/docs
# Admin login   http://localhost:5173/admin/login
```

Credenciales de administración en el `.env` de la raíz
(`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD`).

Si se recrea la base de datos (`docker compose down -v`), hay que
reaplicar migraciones y volver a sembrar:

```bash
cd services/face-service   && npx prisma migrate deploy
cd ../access-service       && npx prisma migrate deploy && npx ts-node prisma/seed.ts
cd ../auth-service         && npx prisma migrate deploy
cd ../shift-service        && npx prisma migrate deploy
```

**Si la base de datos ya existía antes de la Fase 2**, el schema
`shift_svc` no está: los archivos de `infrastructure/postgres/init/`
solo se ejecutan al crear el volumen. Aplícalo sin perder los rostros
enrolados:

```bash
node scripts/apply-shift-schema.mjs
cd services/shift-service && npx prisma migrate deploy
```

---

## Errores que ya se cometieron, para no repetirlos

- `.gitignore` con reglas sin anclar (`logs/`) llegó a ignorar código
  fuente. Ancla siempre los nombres genéricos con `/`.
- `tsc --noEmit` deja un `tsconfig.tsbuildinfo` que hace que el
  siguiente `nest build` no emita nada. Ya está resuelto apuntando
  `tsBuildInfoFile` dentro de `dist/`.
- `COPY prisma* ./` en Docker copia el *contenido* del directorio, no el
  directorio. Por eso hay dos Dockerfiles de NestJS.
- `ultralytics` arrastra `opencv-python` (con GUI) que falla sin X11 en
  imágenes slim. Se fuerza la variante headless.
- Verifica siempre lo que afirmes sobre los modelos. El primer
  `rostros.pt` que entregó el usuario resultó ser un detector de tráfico;
  se descubrió inspeccionando el archivo en lugar de asumir.
- **No midas tasas de error con datos que el propio umbral ha
  clasificado.** Se intentó y salían cero siempre. Está explicado en
  `access-service/src/stats/threshold.analysis.ts`; no lo "arregles"
  volviendo a contarlas.
- **Un `/health` nunca debe poder colgarse.** El del Shift Service lo
  hacía con Redis caído, porque su cliente reintenta indefinidamente
  —correcto para el consumidor, veneno para una sonda—. Cualquier
  comprobación de dependencia va con plazo.
- **Comprueba lo que devuelve la API, no solo lo que se guarda.** Al
  añadir columnas nuevas, la consulta de la línea de tiempo las
  guardaba bien y las devolvía como `undefined`, porque mapeaba las
  entradas campo a campo.
- Dentro de un contenedor, `localhost` puede resolver a IPv6 y los
  servicios escuchan en IPv4. Usa `127.0.0.1` al probar desde dentro.
- `docker compose up -d --build <servicio>` reconstruye también sus
  dependencias, incluido el vision-service. Para tocar solo los
  servicios Node: `docker compose build a b c` y luego
  `docker compose up -d --no-deps a b c`.
- **Esta máquina no sirve como banco de pruebas sin cuidado.** El mismo
  binario dio 2.28 y 0.85 frames/s en la misma sesión, con la carga del
  sistema pasando de 3.6 a 9.8. Si mides rendimiento: calienta primero
  (con varios procesos hay que despertarlos a todos con ráfagas
  concurrentes, o los fríos pagan su primera inferencia y falsean el
  resultado), repite y usa la mediana, y compara configuraciones
  **seguidas**, nunca contra un número de hace media hora.
- Docker Desktop se cae solo en esta máquina de vez en cuando. Si algo
  deja de responder, compruébalo antes de buscar el fallo en el código.
- La resolución de DNS de Docker Hub falla a ratos en esta máquina
  (`lookup auth.docker.io: no such host`). No es el proyecto: reintenta
  el `docker compose build` y a la segunda suele ir.
- **Cuidado al lanzar `node scripts/ci-local.mjs` sin `--rapido` y
  cortarlo.** Hace `npm ci` servicio por servicio, y si se interrumpe
  en medio deja un `node_modules` a medias que después falla con
  `ENOTEMPTY`. Se arregla con `rm -rf node_modules && npm ci`.
- **Un span puede nacer sin registrar y no avisar de nada.** Si un tramo
  no aparece en la traza y no hay ningún error, sospecha del contexto
  del que cuelga: derivar de `context.active()` dentro de un bloque con
  el trazado suprimido hereda la supresión. Ver el ADR 0009.
- **No mires una métrica de OpenTelemetry por su nombre de Prometheus a
  ojo.** `otelcol_receiver_accepted_spans` no lleva sufijo `_total` en
  la versión actual del Collector, y buscarlo con el sufijo da «no hay
  datos» cuando en realidad todo funciona. Pregunta al endpoint de
  métricas antes de concluir que algo está roto.
- **Los límites por defecto de un histograma mienten con educación.**
  El p95 de una etapa que tarda 400 ms salía 1700 ms porque el bucket
  iba de 1 s a 2 s. El número no era falso: era la única respuesta
  posible con esa resolución. Ajusta los límites al rango real del
  sistema.
