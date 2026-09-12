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
**Fases 1 y 2 completadas.**

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

---

## Limitaciones conocidas y asumidas

Están documentadas en el README; **no las "descubras" como si fueran
fallos**:

1. **Sin anti-spoofing.** Una foto en un móvil pasaría la
   autenticación. El sistema no es apto para producción real.
2. **Cobertura de tests desigual.** Hay 111 tests sobre las piezas que
   deciden algo: política de acceso (31), votación (12), anti-passback
   (19), contrato del evento (9), relay de la outbox (8), máquina de
   turnos (25) y parser del evento (7). Todas son funciones puras o con
   dobles, así que corren en segundos y sin contenedores.

   Lo que **sigue sin tests** es el pipeline de reconocimiento y el
   enrolamiento, que necesitan imágenes y modelos reales. La prueba de
   humo los cubre de extremo a extremo, pero no como test unitario.
3. **Sin revocación de tokens.** Uno robado vale hasta caducar (8 h).
4. ~~Estado de votación en memoria~~ **resuelto**: las ventanas se
   comparten en Redis. Lo que no escala ahora es el consumidor del
   shift-service: con varios, los eventos de una persona podrían
   procesarse a destiempo (la máquina descarta lo desordenado, así que
   perdería transiciones y no las corrompería).
5. **Umbral 0.38 sin calibrar con la cámara real.** Se eligió con datos
   de fotos de archivo.
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

### Fase 3 — Home y Dashboard
- `/home` tras verificarse: saludo, hora de entrada, horas acumuladas,
  y un botón a la derecha que lleva al Dashboard
- Dashboard de operación: aforo en tiempo real, **distribución de
  similitudes intra vs inter persona** (convierte el umbral en una
  decisión con datos), accesos denegados por motivo, feed en vivo,
  mapa de calor por hora

### Fase 4 — Observabilidad
- OpenTelemetry en los 5 servicios + Prometheus + Grafana
- El objetivo concreto: una traza que muestre Gateway → Access → Face →
  Vision con los tiempos de cada etapa. Es la captura más diferenciadora
  para el post

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

### Pendiente menor pero acordado
Asignar el rol **en el alta de la persona** (hoy solo por API o con
`scripts/assign-role.mjs`). Lo estándar en la industria es que el alta
sea un onboarding: datos → rol → captura del rostro. Una persona sin rol
es un registro inútil.

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
