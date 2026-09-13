# Control de Acceso por Reconocimiento Facial

Sistema de control de acceso que identifica personas por su rostro
usando una cámara web. Arquitectura de microservicios: detección con un
modelo YOLO propio (`rostros.pt`), identificación con embeddings
ArcFace, y búsqueda por similitud en PostgreSQL con pgvector.

---

## Qué hace

1. El usuario abre la aplicación y ve el vídeo de la cámara.
2. El backend detecta rostros y dibuja una caja sobre cada uno.
   - **Verde** → persona registrada, se muestra su nombre.
   - **Roja** → rostro desconocido.
3. Tras confirmar la identidad en varios fotogramas seguidos, concede el
   acceso y redirige a **`/home`**, donde la persona ve su estado de
   turno, la hora de entrada, las horas acumuladas y la línea de tiempo
   de su jornada.
4. Una sección de administración permite registrar personas, capturar su
   rostro y eliminarlas, y ofrece un **panel de operación** con el aforo
   en tiempo real, la actividad de las puertas y dos análisis: la
   distribución de similitudes frente al umbral y el mapa de actividad
   por hora.

**La decisión de acceso se toma íntegramente en el servidor.** El
frontend solo dibuja lo que el backend le dice.

---

## Arquitectura

```
                        ┌──────────────────────────┐
                        │   FRONTEND (React 19)    │
                        │  captura ~5 fps → JPEG   │
                        └────────────┬─────────────┘
                                     │ REST (multipart / JSON)
                        ┌────────────▼─────────────┐
                        │   API GATEWAY (NestJS)   │
                        │  el único puerto abierto │
                        │  guard admin · guard /me │
                        └──┬────────┬────────┬─────┘
           ┌───────────────┘        │        └───────────────┐
           ▼                        ▼                        ▼
 ┌───────────────────┐   ┌────────────────────┐   ┌────────────────────┐
 │   AUTH SERVICE    │   │    FACE SERVICE    │   │   ACCESS SERVICE   │
 │  NestJS + Prisma  │   │  NestJS + Prisma   │◄──│  NestJS + Prisma   │
 │                   │   │                    │   │                    │
 │ · login admin     │   │ · personas (CRUD)  │   │ · política acceso  │
 │ · argon2id        │   │ · enrolar rostro   │   │ · votación frames  │
 │ · emite JWT admin │   │ · búsqueda vector  │   │ · anti-passback    │
 │                   │   │                    │   │ · PRESENCIA        │
 └─────────┬─────────┘   └─────────┬──────────┘   └────┬──────────┬────┘
           │                       │ imagen            │          │
           │                       ▼                   │  evento  │
           │             ┌────────────────────┐        │  (outbox)│
           │             │   VISION SERVICE   │        │          ▼
           │             │  Python + FastAPI  │        │   ┌─────────────┐
           │             │    ⚠ SIN ESTADO    │        │   │    REDIS    │
           │             │                    │        │   │   Streams   │
           │             │ · rostros.pt       │        │   └──────┬──────┘
           │             │ · landmarks        │        │          │
           │             │ · ArcFace          │        │          ▼
           │             └────────────────────┘        │   ┌─────────────────┐
           │                                           │   │  SHIFT SERVICE  │
           │                                           │   │ NestJS + Prisma │
           │                                           │   │                 │
           │                                           │   │ · estados turno │
           │                                           │   │ · línea tiempo  │
           │                                           │   │ · horas         │
           │                                           │   │ ⚠ PROYECCIÓN    │
           │                                           │   └────────┬────────┘
           ▼                                           ▼            ▼
      ┌──────────────────────────────────────────────────────────────────┐
      │                    PostgreSQL 17 + pgvector                      │
      │      auth_svc  ·  face_svc  ·  access_svc  ·  shift_svc          │
      │            (un schema y un rol por servicio)                     │
      └──────────────────────────────────────────────────────────────────┘
```

La flecha de la derecha es la parte nueva y va **en un solo sentido**.
El Access Service publica lo que ocurrió; el Shift Service lo
interpreta. Nunca al revés: si el Shift Service se cae, las puertas
siguen funcionando y los eventos esperan en la outbox. Ver
[ADR 0007](docs/adr/0007-eventos-y-presencia.md).

### Responsabilidad de cada servicio

| Servicio | Responsabilidad | Base de datos |
|---|---|---|
| **api-gateway** | Punto de entrada único. Enruta, valida, aplica CORS y rate limiting, verifica el token de administración, normaliza errores. **Cero lógica de reconocimiento.** | — |
| **auth-service** | Cuentas de administración. Verifica contraseñas con argon2id y emite el token que protege `/admin/*`. | schema `auth_svc` |
| **face-service** | Dueño de las identidades y de los vectores faciales. Enrola, busca y elimina. | schema `face_svc` |
| **access-service** | Decide si se concede el acceso. Votación multi-frame, política, anti-passback, presencia, auditoría, emisión de sesión. **Única autoridad sobre si una puerta se abre.** | schema `access_svc` |
| **shift-service** | Jornada laboral: estados de turno, línea de tiempo y horas. **Proyección de los eventos del Access Service**; no decide nada que abra una puerta. | schema `shift_svc` |
| **vision-service** | Convierte píxeles en vectores. No conoce identidades ni toca la base de datos. | ninguna |
| **voice-service** | Convierte audio en texto estructurado para la bitácora de relevo. **Devuelve borradores, no registros**; no conoce identidades ni toca la base de datos. | ninguna |
| **logbook-service** | Dueño de la bitácora de relevo: partes ya **firmados**. Sin edición ni borrado; una corrección es un parte nuevo. | schema `logbook_svc` |

### Por qué las identidades están separadas así

Una persona y su rostro son la misma entidad y siempre se consultan
juntas: separarlas obligaría a un join distribuido en cada
reconocimiento, que es el camino crítico. Por eso viven en el mismo
servicio.

En cambio, las personas que **administran** el sistema y las que el
sistema **reconoce** son dominios distintos que solo comparten la
palabra "persona". Las cuentas de administración viven en el Auth
Service, con su propio schema y su propio rol de PostgreSQL: ningún otro
servicio puede leer los hashes de contraseñas, aunque su código lo
intentara.

---

## Cómo funciona el reconocimiento

```
frame JPEG
   │
   ├─[1] DETECCIÓN ....... rostros.pt (YOLOv8s) → cajas + confianza
   │
   ├─[2] CALIDAD ......... descarta: cara pequeña, borrosa o cortada
   │
   ├─[3] LANDMARKS ....... 2d106det → 5 puntos canónicos
   │
   ├─[4] ALINEACIÓN ...... transformación de similitud → 112×112
   │
   ├─[5] EMBEDDING ....... ArcFace w600k_r50 → vector 512-d (norma L2 = 1)
   │
   ├─[6] BÚSQUEDA ........ pgvector: ORDER BY embedding <=> $1
   │
   ├─[7] UMBRAL .......... similitud coseno ≥ RECOGNITION_THRESHOLD
   │
   └─[8] VOTACIÓN ........ 3 coincidencias de 5 frames → ACCESO
```

### Por qué hacen falta dos modelos

`rostros.pt` es un **detector**: dice *dónde* hay una cara, no *de
quién* es. Se verificó ejecutándolo:

```
task: detect · nc: 1 · names: {0: 'rostro'} · cabeza: Detect
```

Una sola clase y sin landmarks. Para identificar personas hace falta un
modelo de embeddings encima. Se eligió **ArcFace** (InsightFace
`w600k_r50`) por su función de pérdida de margen angular, que separa
identidades con mucha holgura.

Medido sobre el pipeline completo con 6 rostros
(`tests/test_recognition_quality.py`):

| | Similitud coseno |
|---|---|
| Misma persona (incluyendo una captura degradada) | 0.49 – 0.99 |
| Personas distintas (15 pares) | −0.08 – 0.24 |

Ese hueco es lo que hace fiable el umbral de 0.38. Ojo: el peor caso
legítimo queda 0.11 por encima del umbral, así que **la calidad de la
captura importa tanto como el umbral** — de ahí el filtro de calidad
previo.

### Por qué la alineación es obligatoria

ArcFace fue entrenado con recortes de 112×112 alineados por 5 puntos
faciales. Pasarle un recorte crudo de una caja de YOLO degrada la
precisión de forma notable. Como `rostros.pt` no entrega landmarks, se
estiman con el modelo `2d106det` y se reducen a los 5 puntos canónicos.

Los índices de esa reducción (`[33, 96, 86, 65, 61]`) **se derivaron
midiendo**, no copiándolos de un tutorial: se compararon los 106
landmarks contra los 5 puntos nativos de SCRFD y se validó que los
embeddings resultantes coinciden con similitud **0.977–0.997**.

### Limitación conocida del detector

Medido con `scripts/benchmark_detector.py`:

| Escenario | Resultado |
|---|---|
| Foto de grupo 1280 px, `imgsz=640` | 0 detecciones (rostros a ~53 px tras reescalar) |
| Misma foto con `imgsz=1280` | 6 detecciones, conf 0.88 |
| Rostro cercano tipo webcam, `imgsz=640` | 1 detección, conf 0.86 ✓ |

Para control de acceso (una persona frente a la cámara) `imgsz=640` es
suficiente y más rápido. Para escenas amplias, subir `YOLO_IMAGE_SIZE`.

---

## Presencia, turnos y anti-passback

Reconocer una cara resuelve *quién eres*. A partir de ahí el sistema
lleva dos cosas más, y las lleva **por separado a propósito**.

### La presencia física — Access Service

Quién ha pasado por una zona y no ha salido. Se escribe en la **misma
transacción** que la concesión del acceso, porque gobierna una puerta:

> El estado que gobierna una puerta no puede ser eventualmente
> consistente.

Sobre ella funciona el **anti-passback**: no puedes entrar dos veces sin
haber salido. Se configura por zona, con tres modos:

| Modo | Qué hace | Para qué zona |
|---|---|---|
| `HARD` | Deniega el paso | Laboratorio, sala de servidores |
| `SOFT` | Concede, corrige la presencia y anota la anomalía | Puerta de la calle |
| `OFF` | No comprueba nada | Zonas sin lector de salida |

El valor por defecto es `SOFT` y no `HARD`, porque al desplegar nadie ha
"entrado" todavía según el sistema: con el modo estricto por defecto, el
estreno del anti-passback consistiría en dejar a la plantilla encerrada.

Un punto de acceso **bidireccional** deduce el sentido de la presencia:
si estás fuera, entras; si estás dentro, sales. Y una segunda lectura en
la misma puerta dentro de la **ventana de gracia** (10 s por defecto) es
la misma persona seguida delante del lector, no un paso nuevo: se
concede, se audita, y la presencia no se mueve.

### La jornada laboral — Shift Service

Su interpretación en términos de trabajo, proyectada desde los eventos:

| Estado | Significa | ¿Computa? |
|---|---|---|
| `FUERA` | Sin jornada abierta | — |
| `EN_TURNO` | Dentro y trabajando | Sí |
| `EN_DESCANSO` | En una zona marcada como de descanso | No |
| `EN_PAUSA` | Salió de la sede con la jornada abierta | Provisional |

**`EN_PAUSA` es la pieza interesante.** Cuando alguien sale, el sistema
no puede saber si volverá en diez minutos o si se ha ido a casa. Casi
todos estos sistemas adivinan, y adivinan mal en las dos direcciones: o
cierran la jornada en cuanto sales —y quien baja a por un café aparece
con dos jornadas— o no la cierran nunca —y quien se va a casa acumula
horas mientras duerme—.

Aquí no se adivina. Salir abre una pausa declaradamente provisional, y
el tiempo decide: si vuelve, la pausa se cierra y la jornada continúa;
si no vuelve, el reconciliador la convierte en el cierre de la jornada
**con la hora de inicio de la pausa**, no con la del momento en que se
dio cuenta.

Salir de una zona tampoco es salir del edificio: quien sale del
laboratorio y sigue en las oficinas vuelve a estar en turno, no de
pausa. Ese dato lo calcula el Access Service —el único que tiene la
presencia— y viaja en el evento.

### Cómo viajan los hechos entre los dos

```
concesión de acceso
   │
   └─ UNA transacción ─┬─ sesión emitida
                       ├─ asiento de auditoría
                       ├─ presencia actualizada
                       └─ evento en la OUTBOX
                                │
                       relay (SKIP LOCKED)
                                │
                                ▼
                       Redis Streams  access.events
                                │
                       grupo de consumidores
                                │
                                ▼
                       Shift Service · idempotente por eventId
```

El evento no se publica directamente porque escribir en PostgreSQL y
publicar en Redis no puede ser atómico: un fallo entre ambas cosas
perdería el paso. Y aquí un paso perdido **son horas trabajadas que no
se le computan a alguien**. La outbox lo convierte en "al menos una
vez", que es la garantía que se quiere: entre repetir y perder, se
repite; y repetir es inofensivo porque el consumidor descarta lo que ya
vio.

---

## El panel de operación

En `/admin/dashboard`, tras iniciar sesión como administrador. Muestra
datos de toda la plantilla, así que no basta con haberse identificado
ante la cámara.

**Aforo y actividad.** Personas dentro (personas distintas, no pasos),
desglose por estado de turno y por zona, actividad reciente de las
puertas y denegaciones agrupadas por motivo. Se refresca cada cinco
segundos.

Las denegaciones se colorean por familia, y esa separación es la razón
de ser del enum: *no se reconoció a la persona* apunta a la cámara, la
luz o el enrolamiento; *reconocida pero sin permiso* apunta a los roles
o al horario. Son incidentes distintos y se investigan en sitios
distintos.

**Distribución de similitudes.** Las dos nubes sobre el mismo eje, con
el umbral dibujado encima. Es lo que convierte el 0.38 en una decisión
con datos del despliegue en lugar de un número heredado de fotos de
archivo, y lo que destapó que el margen real es cuatro veces más
estrecho de lo medido en su día (ver limitación 4).

> El panel avisa en pantalla de lo que este gráfico **no** puede decir:
> tasas de error. Las dos nubes las separa el propio umbral que se
> evalúa, así que jamás se verá solapamiento por mucho que lo haya.

**Mapa de actividad por hora.** Día de la semana por hora, en la hora
local de la sede. Enseña los picos de entrada y salida y, sobre todo, lo
que no debería estar ahí: una celda donde se deniega casi todo se tiñe
de rojo aunque tenga poca actividad.

---

## Estructura del proyecto

```
backend_detector/
├── api-gateway/              NestJS · punto de entrada único
│   └── src/
│       ├── admin/            rutas de administración + guard preparado
│       ├── auth/             verificación de frames
│       ├── proxy/            clientes hacia los microservicios
│       └── common/           validación, errores, imágenes
│
├── services/
│   ├── face-service/         NestJS + Prisma · identidades
│   │   ├── prisma/           schema y migraciones
│   │   └── src/
│   │       ├── persons/      CRUD de personas
│   │       ├── faces/        enrolamiento y búsqueda vectorial
│   │       └── vision/       cliente del Vision Service
│   │
│   ├── auth-service/         NestJS + Prisma · cuentas de administración
│   │   └── src/admin/        login argon2id, bloqueo, primera cuenta
│   │
│   ├── shift-service/        NestJS + Prisma · jornada laboral
│   │   └── src/
│   │       ├── shifts/       máquina de estados y reconciliador
│   │       ├── consumer/     grupo de consumidores de Redis Streams
│   │       └── redis/        conexión al bus
│   │
│   ├── access-service/       NestJS + Prisma · decisión y auditoría
│   │   └── src/
│   │       ├── verification/ votación multi-frame
│   │       ├── policy/       motor de autorización (función pura)
│   │       ├── presence/     presencia y anti-passback
│   │       ├── outbox/       publicación de eventos al bus
│   │       ├── logs/         registro de intentos
│   │       └── face/         cliente del Face Service
│   │
│   └── vision-service/       Python + FastAPI · sin estado
│       ├── app/
│       │   ├── detection/    interfaz + backend YOLO + backend SCRFD
│       │   ├── recognition/  alineación, ArcFace, calidad
│       │   ├── services/     pipeline completo
│       │   └── api/v1/       endpoints
│       ├── scripts/
│       │   ├── inspect_model.py       ← analiza rostros.pt
│       │   └── benchmark_detector.py  ← mide sus límites
│       └── tests/
│
├── frontend/                 React + Vite + TypeScript
│   └── src/
│       ├── pages/            autenticación, bienvenida, administración
│       ├── components/       visor, cajas, asistente de alta, UI
│       ├── hooks/            cámara y bucle de autenticación
│       └── lib/              cliente de API
│
├── modelos/                  rostros.pt (solo lectura)
├── infrastructure/
│   ├── docker/               Dockerfile común de NestJS
│   ├── postgres/init/        schemas, roles y permisos
│   └── observability/        colector, Tempo, Prometheus y Grafana
│       └── grafana/          fuentes de datos y paneles, como código
├── docs/adr/                 decisiones de arquitectura
├── docker-compose.yml
├── TECHNOLOGIES.md
└── README.md
```

---

## Instalación

### Requisitos

- Docker Desktop (la vía recomendada)
- O bien, para desarrollo local: Node.js 24+, Python 3.12, PostgreSQL 17
  con pgvector

### Variables de entorno

```bash
cp .env.example .env
```

Genera secretos reales:

```bash
# Contraseñas de base de datos
openssl rand -base64 24

# JWT_SECRET (mínimo 32 caracteres; el servicio no arranca si es corto)
openssl rand -base64 48
```

Rellena en `.env`: `POSTGRES_PASSWORD`, `FACE_SVC_DB_PASSWORD`,
`ACCESS_SVC_DB_PASSWORD`, `AUTH_SVC_DB_PASSWORD`, `SHIFT_SVC_DB_PASSWORD`
y `JWT_SECRET`.

> Genera las contraseñas de base de datos con `base64url` y no con
> `base64`: un `/` o un `+` rompen la URL de conexión de Prisma.
> `openssl rand -base64 24 | tr '+/' '-_'` sirve.

### Variables principales

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `RECOGNITION_THRESHOLD` | `0.38` | Similitud coseno mínima para aceptar una identidad |
| `RECOGNITION_VOTES_REQUIRED` | `3` | Coincidencias necesarias para conceder acceso |
| `RECOGNITION_WINDOW_SIZE` | `5` | Tamaño de la ventana de votación |
| `YOLO_CONFIDENCE_THRESHOLD` | `0.45` | Confianza mínima del detector |
| `YOLO_IMAGE_SIZE` | `640` | Resolución de inferencia. Subir para escenas amplias |
| `MIN_FACE_SIZE_PX` | `80` | Rostros menores se descartan |
| `FACE_DETECTOR_BACKEND` | `yolo` | `yolo` (rostros.pt) o `scrfd` (InsightFace) |
| `JWT_EXPIRES_IN` | `15m` | Duración de la sesión |
| `CORS_ORIGINS` | `http://localhost:5173` | Orígenes permitidos |
| `ADMIN_AUTH_ENABLED` | `true` | Protección de `/admin/*`. Solo desactivar en depuración local |
| `ADMIN_TOKEN_EXPIRES_IN` | `8h` | Duración de la sesión de administración |
| `ADMIN_BOOTSTRAP_EMAIL` | `admin@detector.local` | Correo de la primera cuenta |
| `ADMIN_BOOTSTRAP_PASSWORD` | — | Contraseña inicial. Mínimo 12 caracteres |
| `REDIS_URL` | `redis://localhost:6380` | Bus de eventos y ventanas de votación compartidas. Sin ella, votación en memoria y eventos en espera |
| `VOTE_WINDOW_BACKEND` | `redis` | `redis` comparte las ventanas entre réplicas; `memory` las deja en el proceso |
| `ANTIPASSBACK_GRACE_SECONDS` | `10` | Dos lecturas en la misma puerta dentro de esta ventana son el mismo paso |
| `SHIFT_PAUSE_TIMEOUT_MINUTES` | `90` | Pasado este tiempo, una pausa se convierte en el cierre de la jornada |
| `SHIFT_MAX_HOURS` | `16` | Una jornada abierta más tiempo es alguien que se fue sin fichar |

---

## Ejecución con Docker

```bash
docker compose up --build
```

La primera construcción tarda varios minutos: descarga PyTorch y los
modelos de InsightFace (~700 MB).

| Servicio | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API Gateway | http://localhost:3000 |
| Swagger del Gateway | http://localhost:3000/docs |
| PostgreSQL | `127.0.0.1:5433` (solo local) |
| Redis | `127.0.0.1:6380` (solo local) |

Aplica las migraciones la primera vez:

```bash
docker compose exec face-service   npx prisma migrate deploy
docker compose exec access-service npx prisma migrate deploy
docker compose exec auth-service   npx prisma migrate deploy
docker compose exec shift-service  npx prisma migrate deploy
docker compose exec access-service npx prisma db seed
```

> **Si ya tenías el proyecto en marcha antes de la fase de turnos**, el
> schema `shift_svc` no existe: los archivos de
> `infrastructure/postgres/init/` solo se ejecutan al crear el volumen.
> Aplícalo sin perder los rostros ya enrolados:
>
> ```bash
> node scripts/apply-shift-schema.mjs
> cd services/shift-service && npx prisma migrate deploy
> ```

---

## Ejecución local (desarrollo)

Cada servicio en su propia terminal.

> Las migraciones leen la conexión del `.env` de la **raíz** del
> proyecto. Un `.env` dentro del directorio del servicio, si existe,
> tiene prioridad; no hace falta crearlo.

**1. PostgreSQL y Redis**

```bash
docker compose up postgres redis -d
```

**2. Vision Service**

```bash
cd services/vision-service
python -m venv .venv
.venv/Scripts/activate          # Windows
pip install torch==2.14.0 torchvision==0.29.0 --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt

# Comprueba el modelo antes de arrancar
python scripts/inspect_model.py

uvicorn app.main:app --reload --port 8000
```

**3. Face Service**

```bash
cd services/face-service
npm install
npx prisma migrate deploy
npm run start:dev
```

**4. Access Service**

```bash
cd services/access-service
npm install
npx prisma migrate deploy
npm run start:dev
```

**5. Shift Service**

```bash
cd services/shift-service
npm install
npx prisma migrate deploy
npm run start:dev
```

**6. API Gateway**

```bash
cd api-gateway
npm install
npm run start:dev
```

**7. Frontend**

```bash
cd frontend
npm install
npm run dev
```

Abre http://localhost:5173.

> La cámara del navegador exige un contexto seguro. `localhost` cuenta
> como tal; si sirves desde otra IP necesitarás HTTPS.

---

## Cómo entrar como administrador

La primera cuenta se crea sola al arrancar el Auth Service, usando
`ADMIN_BOOTSTRAP_EMAIL` y `ADMIN_BOOTSTRAP_PASSWORD` de tu `.env`. Solo
ocurre si no existe ninguna cuenta todavía.

1. Entra en **http://localhost:5173/admin/login**.
2. Usa el correo y la contraseña de tu `.env`.
3. La sesión dura 8 horas y muere al cerrar la pestaña.

El servicio se niega a crear la cuenta inicial si la contraseña tiene
menos de 12 caracteres o si el correo no es válido: sería una cuenta
inutilizable o insegura. Revisa los logs de `auth-service` si no
aparece.

> Cuando tengas el sistema en marcha, cambia la contraseña y retira
> `ADMIN_BOOTSTRAP_PASSWORD` del entorno.

---

## Cómo registrar una persona

El alta es un asistente de **tres pasos**, y los tres hacen falta:

1. Inicia sesión y entra en **http://localhost:5173/admin/faces**.
2. Pulsa *Nueva alta*.
3. **Datos.** Nombre y, opcionalmente, un identificador.
4. **Rol.** Se elige de la lista, que muestra debajo de cada rol las
   zonas y horarios que habilita: lo que decide si alguien pasa no es
   el nombre del rol, son sus permisos.
5. **Rostro.** Colócate de frente y con buena luz, pulsa *Capturar*,
   revisa la imagen y pulsa *Registrar*. El backend detecta el rostro,
   genera el vector y lo asocia a la persona. **La fotografía se
   descarta.**

El registro del rostro se rechaza si: no hay rostro, hay más de uno, la
calidad es baja, o el rostro aparece cortado. Cada rechazo indica el
motivo.

Puedes registrar varios rostros por persona (distintas condiciones de
luz o gafas) para mejorar el reconocimiento.

### Por qué el rol va en el alta, y no aparte

Una persona sin rol es un **registro inútil**: el sistema la reconoce y
no la deja pasar por ninguna puerta. Cuando el alta solo pedía el
nombre, eso pasaba sin que nadie se enterase, y `NO_ROLE_ASSIGNED` se
convirtió en la segunda causa de denegación del despliegue.

Dar de alta a alguien son tres escrituras en **dos servicios** —la
identidad vive en el Face Service y el rol en el Access Service— y no
hay ninguna transacción que las abarque. La respuesta no es montar una
transacción distribuida para tres llamadas, sino hacer el estado
incompleto **visible y retomable**:

- La lista marca en ámbar a quien le falte el rol o el rostro.
- El botón de cada fila lleva **al paso que le falta**, no siempre a la
  captura.
- El rostro va el último a propósito: es el paso lento y el que más
  falla, así que una interrupción deja como mucho a alguien creado y con
  rol, que es un estado visible y que se retoma en un clic.

Lo que **no** se hizo es exigir el rol en el Face Service. Obligaría a
que el servicio de identidades llamase al de acceso, invirtiendo la
única dirección de dependencia que hoy está limpia. Un rol es una
decisión del dominio de acceso; el Face Service no tiene por qué saber
que existen.

Queda una consecuencia asumida: **por API todavía se puede crear a
alguien sin rol.** Es el asistente quien lo exige, no el servidor.

---

## Endpoints principales

Todo pasa por el Gateway: `http://localhost:3000/api/v1`

### Autenticación

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/auth/verify-frame` | Envía un frame, recibe el veredicto |

Respuesta:

```json
{
  "authenticated": true,
  "person": { "id": "uuid", "name": "Diego Ossa" },
  "confidence": 0.91,
  "bbox": { "x": 120, "y": 80, "width": 200, "height": 200 },
  "faces": [
    {
      "bbox": { "x": 120, "y": 80, "width": 200, "height": 200 },
      "recognized": true,
      "personName": "Diego Ossa",
      "personId": "uuid",
      "confidence": 0.91
    }
  ],
  "imageWidth": 640,
  "imageHeight": 480,
  "reason": "GRANTED",
  "sessionKey": "uuid",
  "votes": { "current": 3, "required": 3 },
  "accessToken": "eyJhbGci..."
}
```

Para un rostro no registrado:

```json
{
  "authenticated": false,
  "person": null,
  "confidence": 0.19,
  "bbox": { "x": 120, "y": 80, "width": 200, "height": 200 },
  "reason": "BELOW_THRESHOLD",
  "votes": { "current": 0, "required": 3 }
}
```

Valores de `reason`: `GRANTED`, `BELOW_THRESHOLD`, `NO_FACE_DETECTED`,
`MULTIPLE_FACES`, `LOW_QUALITY`, `INSUFFICIENT_VOTES`,
`PERSON_SUSPENDED`, `NO_ROLE_ASSIGNED`, `NO_PERMISSION_FOR_ZONE`,
`OUTSIDE_SCHEDULE`, `ASSIGNMENT_EXPIRED`, `ACCESS_POINT_DISABLED`,
`ANTIPASSBACK_VIOLATION`.

Los cinco de autorización se distinguen de los de identificación a
propósito: "no te reconozco" y "te reconozco pero no puedes pasar" son
incidentes distintos para quien opera el sistema, y se investigan de
forma distinta.

Cuando se concede, la respuesta incluye además `passage`, con el sentido
resuelto del paso (`IN` u `OUT`).

### Sobre uno mismo

**Exigen el token de sesión** que emite el Access Service al reconocer
la cara. Un token de administración **no** sirve aquí, igual que el de
sesión no sirve para administrar: estas rutas responden sobre el sujeto
del token.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/me/shift` | Estado de turno y horas acumuladas |
| `GET` | `/me/timeline` | Línea de tiempo de la jornada (`?date=AAAA-MM-DD`) |

El identificador de la persona no viaja en la ruta ni en la consulta: se
lee del token. Si se aceptara, cualquiera con una sesión válida podría
leer la jornada de sus compañeros cambiando un parámetro.

### Administración

**Todas estas rutas exigen `Authorization: Bearer <token>`**, salvo el
propio inicio de sesión.

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/admin/auth/login` | Inicia sesión, devuelve el token |
| `GET` | `/admin/auth/me` | Comprueba el token y devuelve el administrador |
| `GET` | `/admin/persons` | Lista personas **con su rol** (`?search=`, `?skip=`, `?take=`) |
| `POST` | `/admin/persons` | Crea una persona |
| `GET` | `/admin/persons/:id` | Consulta una persona con su rol |
| `PATCH` | `/admin/persons/:id` | Cambia nombre o estado |
| `DELETE` | `/admin/persons/:id` | Elimina y **borra sus vectores** |
| `POST` | `/admin/persons/:id/faces` | Enrola un rostro (multipart) |
| `GET` | `/admin/access-logs` | Historial de intentos |
| `GET` | `/admin/sites` | Sedes, zonas y puntos de acceso |
| `GET` | `/admin/roles` | Roles y qué permite cada uno |
| `POST` | `/admin/persons/:id/roles` | Asigna un rol |
| `DELETE` | `/admin/persons/:id/roles/:roleId` | Retira un rol |
| `GET` | `/admin/persons/:id/roles` | Roles asignados a una persona |
| `GET` | `/admin/presence` | Quién consta dentro y el aforo por zona |
| `GET` | `/admin/shifts` | Jornadas abiertas y desglose por estado |
| `GET` | `/admin/shifts/:personId/timeline` | Línea de tiempo de una jornada |
| `GET` | `/admin/stats/denials` | Denegaciones agrupadas por motivo |
| `GET` | `/admin/stats/similarity` | Distribución de similitudes y margen del umbral |
| `GET` | `/admin/stats/hourly` | Actividad por día y hora, en hora local de la sede |
| `GET` | `/health` | Estado de todos los servicios |

**Ningún endpoint devuelve embeddings.**

> **El listado de personas es el único sitio donde el Gateway compone
> dos servicios.** La identidad viene del Face Service y el rol del
> Access Service, porque son dominios distintos, pero quien administra
> necesita verlos juntos para detectar a quien no puede pasar por
> ninguna puerta. Unir dos lecturas para una pantalla es trabajo de
> Gateway; decidir con ellas, no, y aquí no se decide nada.
>
> El rol es un dato **accesorio** del listado, y se trata como tal: la
> consulta lleva un plazo de 2 s propio —mucho más corto que el del
> resto del cliente— y, si el Access Service no responde, el campo
> `roles` vuelve como `null` en lugar de romper la pantalla. `null` no
> es lo mismo que `[]`: lo primero es «no se pudo preguntar» y la
> interfaz lo pinta apagado; lo segundo es «no tiene ningún rol» y sí
> es un aviso. Pintarlos igual mandaría al administrador a perseguir un
> problema que no existe.

---

## Base de datos

Una instancia, **un schema y un rol por servicio**. El aislamiento lo
impone PostgreSQL: `face_svc_user` no puede leer `access_svc` aunque su
código lo intentara.

```
face_svc.persons
  id · full_name · external_id · status · deleted_at · created_at · updated_at

face_svc.face_embeddings
  id · person_id · embedding vector(512) · model_name · model_version
  det_score · created_at
  índice HNSW (vector_cosine_ops)

auth_svc.admin_users
  id · email · password_hash (argon2id) · display_name · role
  is_active · failed_attempts · locked_until · last_login_at

access_svc.access_logs
  id · person_id · person_name · authenticated · confidence · reason
  camera_id · session_id · created_at

access_svc.access_sessions
  id · person_id · person_name · issued_at · expires_at · revoked_at

access_svc.presence
  person_id · zone_id · site_id · inside · last_direction
  last_access_point_id · last_passage_at
  clave primaria (person_id, zone_id)

access_svc.outbox_events
  id · type · aggregate_id · payload · published_at · attempts
  índice PARCIAL sobre lo pendiente

shift_svc.work_days
  id · person_id · person_name · site_id · business_date · state
  state_since · started_at · ended_at · closed_by
  worked_seconds · break_seconds
  índice único PARCIAL: una sola jornada abierta por persona

shift_svc.timeline_entries
  id · work_day_id · source_event_id (ÚNICO) · at · from_state · to_state
  direction · zone_name · access_point_name
```

**Tres de esos índices son parciales y ninguno es un detalle de
rendimiento:**

- `outbox_events` pendientes: la consulta del relay corre cada segundo y
  su coste debe crecer con la cola, no con el histórico.
- `work_days` con una sola jornada abierta por persona: es la invariante
  que sostiene todo el servicio de turnos, y se impone en la base de
  datos porque el código se salta con dos procesos concurrentes.
- `timeline_entries.source_event_id` único: es lo que hace idempotente
  al consumidor. El bus entrega "al menos una vez", así que el mismo
  evento puede llegar dos veces; sin esa restricción, las horas se
  contarían dos veces.

Prisma no sabe expresar índices parciales, así que viven solo en las
migraciones. Es otra de las razones por las que se escriben a mano.

**`model_version` no es burocracia:** los embeddings de modelos
distintos ocupan espacios vectoriales incompatibles. Sin esa columna, un
cambio de modelo rompería el reconocimiento de forma silenciosa.

**`person_name` duplicado en `access_logs` es intencionado:** un asiento
de auditoría debe ser inmutable y seguir describiendo lo que pasó aunque
la persona se renombre o se elimine.

---

## Consideraciones de seguridad

### Lo que está implementado

- **Las rutas `/admin/*` exigen autenticación.** Contraseñas con
  argon2id (parámetros OWASP), doble freno a la fuerza bruta (10
  intentos/minuto por IP y bloqueo de 15 minutos tras 5 fallos), y
  mensaje de error idéntico exista o no la cuenta.
- **Un token de acceso facial no sirve para administrar.** Los tokens
  llevan tipo y el guard lo comprueba; sin eso, cualquiera con la cara
  registrada podría borrar a los demás. Hay una prueba automática.
- **Los embeddings nunca salen del backend.** Garantizado por el sistema
  de tipos: Prisma no expone la columna `vector`, así que devolverla por
  error es imposible.
- **No se guarda ninguna imagen facial.** Ni en enrolamiento ni en
  autenticación. Solo el vector.
- **Los logs no contienen datos biométricos.** Se registran métricas
  (cuántos rostros, tiempos, puntuaciones), nunca imágenes ni vectores.
- **Aislamiento por permisos de base de datos**, un rol por servicio.
- **Validación de imágenes por firma de archivo** (números mágicos), no
  por el `Content-Type` que declara el cliente.
- **Límite de tamaño** de subida (8 MB por defecto).
- **Rate limiting** en todos los servicios.
- **CORS restringido** a orígenes declarados; solo el Gateway lo abre.
- **Helmet** en los tres servicios NestJS.
- **El servicio no arranca con un `JWT_SECRET` débil** (mínimo 32
  caracteres).
- **Servicios internos sin puertos publicados**: solo el Gateway es
  alcanzable desde fuera.
- **Contenedores con usuario sin privilegios.**
- **El borrado de una persona elimina físicamente sus vectores**
  (`ON DELETE CASCADE`): derecho al olvido real.
- **Se rechaza el enrolamiento con varios rostros**, para no asociar la
  cara equivocada a un nombre.
- **Se rechaza la autenticación con varios rostros** en el encuadre.
- **Anti-passback**: no se puede entrar dos veces sin haber salido. En
  las zonas en modo estricto se deniega el paso; en las demás se
  concede, se corrige la presencia y queda anotada la anomalía.
- **Un token de sesión facial no sirve para consultar la jornada de
  otro.** Las rutas `/me/*` leen la identidad del token y no aceptan un
  identificador de persona, así que no hay parámetro que manipular.
- **La concesión es atómica.** Sesión, auditoría, presencia y evento se
  escriben en una sola transacción: no puede quedar alguien con sesión
  abierta a quien el sistema crea fuera.

### Lo que NO está implementado

Estas limitaciones son reales y deben conocerse antes de usar el sistema
en producción.

#### 1. Detección de vida SIN VALIDAR — sigue siendo la más importante

Hay detección de vida pasiva desde la Fase 6, y hay que leer con cuidado
qué significa eso: **el mecanismo existe y no está validado.**

Mide dos cosas sobre la textura del rostro —cuánto detalle fino tiene y
si hay un patrón periódico— y el Access Service decide con ellas. Cuesta
4.7 ms de los ~1100 de un frame, medido con la traza.

**Por defecto NO deniega.** El modo es `SOFT`: anota la sospecha en
`acceso_sospechas_de_vida` y deja pasar. El motivo es que nadie ha
medido su tasa de falso rechazo contra ataques reales, y denegar el paso
a una persona real con un número sin calibrar es peor que el problema
que resuelve.

**Ya está medido con un ataque real, y no funciona.** El 2026-09-13 se
probaron, con la misma webcam y seguidas, una cara real y una foto de
esa cara en la pantalla de un móvil. **Las dos entraron, y las dos
señales apuntan al revés:**

| | detalle fino | pico periódico |
|---|---|---|
| Cara real (3 frames) | 0.382 – 0.443 | **24.8 – 43.6** |
| Móvil (4 frames) | 0.357 – 0.442 | **23.7 – 28.9** |

El pico periódico existe precisamente para delatar la rejilla de una
pantalla, y marcó **más alto con la cara real**. El detalle fino da
prácticamente lo mismo en los dos casos. **Esto no es un problema de
umbral**: cualquiera que atrapara el móvil rechazaría antes una cara
real. No se calibra, se sustituye.

**Por qué falla, y es estructural.** La señal se mide sobre el recorte
alineado de 112x112, y para llegar a él la imagen pasa por dos
reducciones sin filtro antialias: el terminal manda 640 px de ancho, y
`norm_crop` remuestrea a 112 con un `warpAffine` bilineal. La rejilla de
una pantalla no sobrevive a eso —se pierde o se pliega por aliasing a
una frecuencia cualquiera—, así que `pattern_peak` no está midiendo
periodicidad: está midiendo si la banda alta tiene estructura marcada, y
una cara real directa tiene más que una pantalla. De ahí el signo
invertido. **Cualquier señal sustituta que dependa de la textura tendrá
que medirse antes de esas reducciones.**

Antes se había intentado fabricar el ataque degradando una imagen, y
aquel intento dejó otro hallazgo que sigue en pie: **el detector deja de
encontrar la cara antes de que la señal reaccione**. Un ataque de
pantalla realista no se fabrica, hay que fotografiar una pantalla.

**Cómo reunir el conjunto con el que medir.** Hay una herramienta para
grabarlo por el mismo camino que captura el terminal:

```bash
node scripts/capture-attack-set.mjs      # abre http://localhost:5174
```

Guarda las dos clases en `datasets/liveness/` —fuera del repositorio,
son rostros reales— con dos variantes de cada disparo: lo que el
terminal envía hoy, y el frame nativo por si una señal futura necesita
más píxeles. Sin ese conjunto no se puede evaluar ninguna alternativa.

Así que la afirmación honesta es más dura que antes: **el sistema no es
apto para control de acceso real**, y su defensa contra suplantación no
solo está sin validar, sino medida y fallando. El
[ADR 0010](docs/adr/0010-deteccion-de-vida.md) detalla las dos vías que
quedan —un modelo entrenado, o el reto activo— y qué haría falta para
encender el modo que sí deniega.

#### 2. Sin revocación de tokens

Un token de administración robado sigue siendo válido hasta que caduca
(8 horas por defecto). Desactivar a un administrador surte efecto en su
siguiente inicio de sesión, no de inmediato.

Añadirlo exige *refresh tokens* con estado en base de datos y una
consulta por petición en el guard, que hoy es puramente stateless.

El token se guarda además en `sessionStorage`, no en una cookie
`httpOnly`, así que un XSS podría robarlo. Ver ADR 0006.

#### 3. ~~Estado de votación en memoria~~ — resuelto

Las ventanas de votación se comparten ahora en Redis, así que el Access
Service ya puede replicarse. Queda la implementación en memoria como
alternativa (`VOTE_WINDOW_BACKEND=memory`) y como modo de degradación:
si Redis no responde, la votación cae a memoria en lugar de fallar. La
dirección del fallo es segura —sin estado compartido cuesta **más**
entrar, nunca menos—, así que se pierde eficiencia y no seguridad.

Lo que **no** escala todavía es el consumidor del Shift Service: ver el
punto 7.

#### 4. El umbral va más ajustado de lo que parecía

`0.38` se eligió con la separación medida sobre las imágenes de prueba
de InsightFace: **0.2552** entre las dos nubes. El panel de operación
mide ahora esa misma separación con los accesos reales de este
despliegue:

| | Fotos de archivo (ADR 0003) | Despliegue real |
|---|---|---|
| Separación entre nubes | 0.2552 | **0.0641** |
| Margen bajo el umbral | — | 0.0286 |
| Margen sobre el umbral | — | 0.0355 |

Es **cuatro veces menor**. El umbral sigue separando las dos nubes, pero
con un margen de tres centésimas: una captura peor de lo normal puede
cruzarlo en cualquiera de los dos sentidos.

Lo que esto dice no es "cambia el número", sino que **el margen depende
de la calidad de la captura** mucho más que del umbral, tal y como
avisaba el ADR 0003. Subirlo dejaría gente fuera; bajarlo acerca a los
desconocidos.

**Importante sobre lo que este dato NO es.** De la auditoría no salen
tasas de error, y el panel lo dice en pantalla: un intento se clasifica
como reconocido o desconocido usando el propio umbral que se evalúa, así
que las dos nubes salen partidas exactamente por él y jamás se verá
solapamiento. Medir tasas de acierto exige datos etiquetados a mano, que
es lo que hace `tests/test_recognition_quality.py` del Vision Service.

#### 5. Embeddings sin cifrar en reposo

Se guardan en claro. Existen ataques de reconstrucción facial a partir
de embeddings, así que en producción conviene cifrado a nivel de columna
o de disco.

#### 6. Sin HTTPS

La configuración es de desarrollo. En producción hacen falta TLS y un
proxy inverso: la cámara exige contexto seguro fuera de `localhost`.

#### 7. El Shift Service no escala horizontalmente

Con varios consumidores en el grupo de Redis, los eventos de una misma
persona podrían procesarse a destiempo. La máquina de estados descarta
lo que llega desordenado, así que el efecto sería perder transiciones y
no corromperlas, pero escalar de verdad exigiría repartir los eventos
por persona en varios streams. Ver [ADR 0007](docs/adr/0007-eventos-y-presencia.md).

#### 8. Una ventana de un segundo en el anti-passback

El anti-passback se evalúa al reconocer y se aplica tras la votación,
así que hay aproximadamente un segundo entre leer el estado de presencia
y escribirlo. En esa ventana solo caben frames de la misma persona, y
una persona no puede estar en dos puertas a la vez — pero con el
anti-spoofing sin validar (limitación 1), una fotografía en una
segunda puerta sí podría colarse por ese hueco.

#### 9. Redis sin alta disponibilidad

Una instancia, sin réplica. Es aceptable porque ninguna de sus dos
funciones puede dejar a nadie fuera de un edificio: la votación degrada
a memoria y los eventos esperan en la outbox hasta que vuelva.

---

## La bitácora de relevo de turno

Un vigilante dicta las novedades al terminar su jornada y el sistema las
ordena en incidencias.

Es un camino aparte del de reconocimiento —el del diagrama de arriba— y
no toca ninguna puerta:

```
  persona identificada por su cara
        │  audio (multipart)
        ▼
  ┌──────────────┐   POST /me/logbook/draft   ┌────────────────────┐
  │ API GATEWAY  │ ─────────────────────────► │   VOICE SERVICE    │
  │ guard /me    │                            │  Python · SIN BD   │
  └──────┬───────┘ ◄───── BORRADOR ────────── │  Deepgram → Gemini │
         │                                    └────────────────────┘
         │   la persona REVISA y FIRMA
         │   POST /me/logbook
         ▼
  ┌────────────────────┐   ¿qué registraron   ┌────────────────────┐
  │  LOGBOOK SERVICE   │ ── las puertas? ───► │   ACCESS SERVICE   │
  │  NestJS + Prisma   │                      │  (solo lectura)    │
  │  partes FIRMADOS   │ ◄─── resumen ─────── └────────────────────┘
  │  inmutables        │      CONGELADO dentro del parte
  └────────────────────┘
```

Si el Voice Service no responde, el parte se escribe a mano. Si el
Access Service no responde, se firma sin el cruce. **Ninguno de los dos
puede impedir que quede constancia de un turno**, y ninguno de los dos
aparece en el `depends_on` del Gateway: el sistema abre puertas aunque
dictar un parte no funcione. El `voice-service` transcribe con Deepgram y
estructura con Gemini, y es **sin estado**: no guarda nada, no conoce
identidades y no decide nada.

### Lo que devuelve es un borrador, no un registro

Nada se guarda hasta que la persona que vivió el turno lo confirma. Con
el umbral de similitud o con el anti-passback decide otro servicio,
porque hay una regla mecánica que aplicar. Un parte de relevo no tiene
regla: es el testimonio de alguien, y es el documento que se lee cuando
algo ha salido mal. **Un renglón inventado ahí manda a una persona a
investigar un hecho que nunca ocurrió.**

### Cómo se comprueba que el modelo no se inventó nada

Al modelo se le exige una **cita literal** de la transcripción por cada
incidencia, y después el servicio comprueba que esa cita existe de
verdad en el texto. Cada incidencia sale marcada con `citaVerificada`.

> «No inventes nada» es una instrucción y no se puede verificar.
> «Enséñame dónde lo leíste» sí.

Una cita que no cuadra **se marca, no se borra**: esconderla sería
perder justo lo que quien revisa necesita ver. El recuento va al span de
la traza como `voice.incidents.unbacked`.

Es lo único de este servicio que se puede probar sin red, y por eso sus
16 casos corren en el CI.

### Si un proveedor se cae, el parte se registra igual

| Qué falla | Qué pasa |
|---|---|
| Gemini | Se devuelve la transcripción sola, y `estructuraOmitidaPor` dice por qué |
| Deepgram | `503` con código `TRANSCRIPTION_UNAVAILABLE`, para ofrecer escribirlo a mano |
| Faltan las claves | El servicio arranca igual y lo avisa en el log |

### Aviso de privacidad

El resto del sistema no deja salir ningún dato biométrico: los vectores
faciales no cruzan la frontera y no se guarda ninguna imagen. **Este
servicio sí**: manda audio a Deepgram y texto a Google, y la voz también
es un dato biométrico.

El audio no se almacena en ningún sitio —ni disco, ni caché, ni logs— y
ni la transcripción ni el texto estructurado aparecen en las trazas, que
solo llevan métricas. Pero la afirmación «ningún dato biométrico sale
del sistema» **deja de ser cierta** con la Fase 5 encendida, y está
dicho aquí para que nadie lo descubra leyendo el código.

### Si dictar devuelve «la transcripción no está disponible»

**Lo primero que hay que descartar no es el código, es la máquina.** El
Voice Service es el único servicio que sale a Internet, así que es el
único al que le afectan estas cosas, y el síntoma no se parece a su
causa. Tres comprobaciones, en este orden.

**1. ¿Resuelve el nombre?**

```bash
docker compose exec voice-service python -c   "import socket; print(socket.gethostbyname('api.deepgram.com'))"
```

Hay routers y filtros que resuelven todo menos ciertos nombres,
devolviendo respuesta vacía en lugar de error. Si falla, pon 1.1.1.1 o
8.8.8.8 como DNS **en el host** —cura además los fallos al construir
imágenes, que vienen de lo mismo—. Parche inmediato:

```bash
docker compose -f docker-compose.yml -f docker-compose.dns.yml up -d
```

**2. ¿Hay un antivirus interceptando el TLS?** Es la causa que más
cuesta identificar, porque el error dice «certificado autofirmado en la
cadena» y suena a problema del servidor:

```bash
docker compose exec voice-service python -c "
import socket, ssl, re
s = socket.create_connection(('api.deepgram.com', 443), timeout=10)
t = ssl._create_unverified_context().wrap_socket(s, server_hostname='api.deepgram.com')
der = t.getpeercert(binary_form=True)
legible = bytes(c if 32 <= c < 127 else 46 for c in der).decode()
print(' | '.join(re.findall(r'[ -~]{5,}', legible)[:4]))"
```

Si ahí aparece el nombre de un antivirus en lugar de una autoridad
conocida, ese antivirus está abriendo y volviendo a firmar la conexión.
**Se comprobó en esta máquina:** 7 de 8 conexiones llegaban firmadas por
«AO Kaspersky Lab», y 9 de cada 10 peticiones fallaban por eso.

El arreglo, en orden de preferencia:

1. **Excluir `api.deepgram.com`** del análisis de conexiones cifradas
   del antivirus. Es lo más quirúrgico y suele arreglar también el
   punto 1, porque ese mismo filtrado actúa sobre el DNS.
2. Desactivar el análisis de HTTPS. Más amplio de lo necesario.
3. Añadir la raíz del antivirus al almacén de confianza del contenedor.
   Funciona, y conviene saber lo que implica: **el antivirus lee el
   audio en tránsito**, y este proyecto es cuidadoso justamente con eso.

**3. ¿Llegó y volvió vacío?** Si el mensaje dice **«no se reconoció
ninguna palabra en el audio»**, entonces la red está bien y es el
micrófono. Los dos mensajes se distinguen a propósito, porque llevan a
buscar en sitios opuestos.

Ver [ADR 0011](docs/adr/0011-voz-e-ia.md).

### Dónde se guarda, y por qué no en el servicio de turnos

En un `logbook-service` con su propio schema y su propio rol. El motivo
no es de gusto: el Shift Service es una **proyección** y podría
reconstruirse entero reprocesando los eventos sin que nadie se quedara
fuera del edificio. **Un parte que dictó una persona no se reconstruye de
ningún evento**, y guardarlo ahí destruiría la propiedad que hace
defendible aquel diseño.

### Lo que hace que un parte valga como registro

- **Solo entra lo firmado.** No hay borradores en la base de datos. El
  borrador vive en el cliente entre dictarlo y firmarlo.
- **Es inmutable.** No hay editar ni borrar, en ningún sitio. Una
  corrección es un parte nuevo que apunta al anterior, y los dos quedan.
- **Firma quien vivió el turno.** La persona sale del token de sesión
  facial, nunca del cuerpo de la petición, y la vista de administración
  es de **solo lectura**: un administrador que pudiera redactar el parte
  de otro convertiría la bitácora en algo que no prueba nada.
- **El cruce con las puertas se congela al firmar.** Un parte es
  evidencia de lo que se sabía entonces; si se compusiera al leerlo,
  diría cosas distintas según el día.

### Cómo se dicta y se firma

En `/relevo`, a la que se llega desde `/home` con la jornada abierta.
Grabas, el sistema propone un resumen y una lista de incidencias, tú las
corriges, y firmas.

**Se llega al final sin micrófono y sin modelo.** Si la transcripción no
está disponible se escribe a mano; si el estructurador no responde,
queda la transcripción y las incidencias se añaden a mano. Un vigilante
que termina su turno no puede irse sin dejar constancia porque un
proveedor externo esté caído.

**La transcripción se muestra y no se edita.** El resumen y las
incidencias sí: son una interpretación. El texto es lo que se dijo, y es
lo que zanja una discusión dentro de seis meses.

**Cada incidencia firmada declara de dónde salió** —aceptada tal cual,
corregida, o escrita a mano—. Solo el cliente puede saberlo, porque el
servidor no ve la propuesta original. Es el dato con el que dentro de
unos meses se podrá responder si el modelo aporta algo o cuesta más
trabajo del que ahorra.

**Y una cita que el modelo no pudo respaldar se ve ANTES de firmar**,
marcada en la propia incidencia. Es lo único que este sistema sabe
detectar sobre la invención de un modelo, y viaja desde el Voice
Service hasta la pantalla.

### Lo que necesita quien entra al turno

`GET /me/logbook/pending` devuelve lo que quedó sin cerrar. Es la
consulta que justifica tener una bitácora: sin ella habría que repasar el
turno anterior entero para enterarse de que el ascensor sigue roto. No
filtra por persona a propósito, porque lo pendiente lo dejó otro. Sale
en `/home` nada más identificarse, que es el momento exacto en que hace
falta.

Ver [ADR 0012](docs/adr/0012-bitacora-de-relevo.md).

---

## Preguntarle al sistema desde un modelo

Hay un **servidor MCP** que expone el dominio como herramientas, para
poder preguntar en lenguaje natural quién está dentro, qué jornadas hay
abiertas o qué dejó pendiente el turno anterior.

```bash
cd services/mcp-server && npm ci && npm run build && npm run smoke
```

Se conecta por stdio a Claude Code o a Claude Desktop; las instrucciones
están en [services/mcp-server/README.md](services/mcp-server/README.md).

**Es un cliente del Gateway, no de la base de datos.** Se autentica con
una cuenta de administración y pasa por los mismos guards que el
navegador: no tiene ni un privilegio que no tenga alguien sentado
delante del panel. Ir directo a PostgreSQL habría sido más rápido y
habría abierto una segunda puerta que nadie vigila.

**Y es de solo lectura, anunciado como tal.** Ninguna herramienta abre
una puerta, firma un parte ni toca una jornada.

> Un modelo conectado a esto puede contar lo que pasó. No puede hacer
> que pase nada.

No es prudencia genérica: la autoridad de este sistema está
deliberadamente concentrada —una puerta la abre el Access Service con
una cara delante de una cámara, un parte lo firma quien vivió el turno—
y una herramienta que hiciera cualquiera de las dos cosas por
interpretación de una frase vaciaría de sentido las dos decisiones. La
prueba de humo lo comprueba explícitamente.

**Lo que expone son datos de terceros:** nombres, horas de entrada y
salida, y lo que alguien declaró en un parte. La regla práctica es no
ejecutarlo donde no dejarías abierto el panel de operación.

Ver [ADR 0013](docs/adr/0013-servidor-mcp.md).

---

## Observabilidad

Los seis servicios exportan trazas y métricas por OTLP a un
**OpenTelemetry Collector**, que las reparte a **Tempo** (trazas) y a
**Prometheus** (métricas). **Grafana** las enseña juntas.

```
  6 servicios ──OTLP──▶ Collector ──▶ Tempo       (trazas)
                            └───────▶ Prometheus  (métricas) ──▶ Grafana
```

| Qué | Dónde |
|---|---|
| Panel «Control de acceso» | http://localhost:3001 (carpeta *Observabilidad*) |
| Prometheus | http://localhost:9090 |

Credenciales de Grafana en el `.env` (`GRAFANA_ADMIN_USER` /
`GRAFANA_ADMIN_PASSWORD`). El puerto es **3001** porque el 3000 lo ocupa
el Gateway, por la misma razón que PostgreSQL usa el 5433.

### Nada de esto puede dejar a nadie fuera de un edificio

Los cuatro contenedores de observabilidad **no aparecen en ningún
`depends_on` de los servicios ni en ningún `/health`**. Si el Collector
deja de responder, los exportadores descartan en silencio con una cola
acotada y el reconocimiento sigue igual. Convertir una avería de
telemetría en una avería de control de acceso sería cambiar un problema
pequeño por uno grave.

Para arrancar sin instrumentación, `OTEL_SDK_DISABLED=true` o dejar
`OTEL_EXPORTER_OTLP_ENDPOINT` vacío. No hay que tocar código.

### La traza cruza el bus de eventos

Una sola traza va del frame hasta la transición de turno:

```
api-gateway → access-service → face-service → vision-service
  → COMMIT de la transacción que escribe la outbox
  ⟨ hueco de ~450 ms ⟩
  → access.events publish → xadd
  → shift-service: access.events process → BEGIN…COMMIT → xack
```

**Ese hueco no es latencia: es el intervalo de sondeo del relay.** El
evento ya está confirmado en PostgreSQL y esperando a que lo recojan,
que es exactamente lo que la outbox transaccional promete.

Funciona porque `outbox_events` guarda el `traceparent` de la petición
en la **misma transacción** que el evento: cuando el relay publica, un
segundo después y en otro proceso, la petición original ya no existe.
El razonamiento completo, y lo que se acepta a cambio, en el
[ADR 0009](docs/adr/0009-observabilidad-con-opentelemetry.md).

### Dónde se va el tiempo de un frame

La pregunta que el proyecto no podía contestar. Medido sobre el stack
real (p95):

| Etapa | p95 | |
|---|---|---|
| Petición completa | ~1 s | |
| `vision.detect` (rostros.pt) | ~740 ms | **el cuello de botella** |
| `vision.embed` (ArcFace) | ~450 ms | |
| `vision.align` | ~31 ms | |
| Búsqueda en pgvector | ~1.2 ms | no interviene |

El coste está en el **detector**, no en el embedding. Y la búsqueda
vectorial —la sospechosa intuitiva, la que justifica el índice HNSW—
cuesta algo más de un milisegundo. Importa porque el margen del umbral
es estrecho (limitación 5) y lo que hace falta no es cambiar el número
sino mejorar la captura: esto dice de qué presupuesto se dispone y de
dónde habría que sacarlo.

> Son contenedores sin GPU en un portátil. Lo que vale es la
> **proporción entre etapas**, no los valores absolutos.

### El techo de capacidad, y por qué existe

Lo primero que enseñó la observabilidad no fue una latencia, fue un
**fallo en cascada esperando a ocurrir**.

Los manejadores del Vision Service eran `async def` pero dentro
llamaban al pipeline, que son cientos de milisegundos de CPU
bloqueante. Eso ocupa el bucle de eventos entero, y con él se congela
todo lo demás que el proceso tenga que atender:

| `/health` del Vision Service | Antes | Después |
|---|---|---|
| En reposo | 1 ms | 1 ms |
| Con frames en vuelo | **3077 ms** | **418 ms** |

El `HEALTHCHECK` de Docker tiene un plazo de 5 s. Con suficientes
frames encolados lo superaba, Docker marcaba el contenedor como enfermo
y lo reiniciaba, perdiendo los modelos cargados. Carga → reinicio → más
carga. Es la misma lección que dejó el `/health` del Shift Service con
Redis caído: **una sonda nunca debe poder colgarse.**

El arreglo es sacar la inferencia a un hilo con `run_in_threadpool`.

### El candado sobre el detector hace el sistema más rápido, no más lento

`ultralytics.predict()` guarda el lote y los resultados colgados del
objeto del modelo, así que dos hilos entrando a la vez se pisan ese
estado. El alineador y el embebedor no lo necesitan: van sobre
onnxruntime, que sí es seguro entre hilos.

Lo interesante es que serializar la detección **no cuesta rendimiento,
lo gana**. Sin el candado, varias inferencias de torch compiten por los
mismos núcleos y se estorban; con él, la detección de un frame corre a
pleno rendimiento mientras la alineación y el embedding de otro —que
sueltan el GIL— se solapan con ella.

### Cuántos procesos

`VISION_WORKERS` existe, y su valor por defecto es **uno**, medido. La
intuición dice que varios procesos multiplicarían el rendimiento, pero
en una máquina de 12 núcleos una sola inferencia de torch ya usa la
mitad, y el segundo worker no dio nada distinguible del ruido a cambio
de casi el doble de memoria. Repartir más fino es peor: con 4 workers
de 3 hilos la latencia de una petición casi se dobla.

> **Sobre las cifras de rendimiento de esta sección.** Se tomaron en un
> portátil con Docker Desktop, y la máquina resultó ser un banco de
> pruebas poco fiable: el mismo binario midió 2.28 frames/s al
> principio de una sesión y 0.85 al final, sin cambiar nada. Lo que
> aguanta es la comparación **hecha seguida**, con la máquina en el
> mismo estado, y la del `/health`, que cambia de orden de magnitud. Si
> vas a citar un número, vuelve a medirlo en la máquina donde vaya a
> correr.

### Lo que no se traza

Los bucles de fondo —el relay cada segundo, la espera del consumidor
cada cinco, los medidores cada quince— y las sondas de salud, que Docker
pega cada 30 s en cada servicio. Sin suprimirlos serían más de cien mil
trazas diarias que solo dicen «no había nada», y enterrarían las que
importan.

### Métricas propias

Solo las que ninguna traza puede dar; las de latencia y error las
fabrica el Collector a partir de las propias trazas.

| Métrica | Para qué |
|---|---|
| `acceso_decisiones_total{motivo,sede,zona}` | Por qué se deniega |
| `acceso_similitud` | Distribución frente al umbral |
| `outbox_retraso_segundos` | **La alarma importante**: edad del evento sin publicar más viejo |
| `outbox_eventos_pendientes` | Cola del emisor |
| `shift_consumidor_pendientes` | Cola del consumidor |

Las dos últimas miden averías **distintas**: una dice «no sale del
emisor», la otra «sale pero no se consume». Y ambas cubren el mismo
punto ciego: el Shift Service es una proyección, así que cuando se
atasca no falla nada visible. Las puertas abren, ninguna petición da
error, y lo único que pasa es que las horas de la gente dejan de
computarse hasta que alguien mira su hoja a final de mes.

---

## Verificar el modelo

```bash
cd services/vision-service

# Qué es rostros.pt: clases, tarea, formato de salida
python scripts/inspect_model.py

# Con una imagen real
python scripts/inspect_model.py --image ruta/a/foto.jpg

# Hasta qué tamaño de rostro detecta
python scripts/benchmark_detector.py
```

`inspect_model.py` abre el modelo en **solo lectura**. No lo reentrena ni
lo sobrescribe.

---

## Pruebas

```bash
node scripts/ci-local.mjs        # reproduce el CI completo en local
node scripts/smoke-test.mjs --enroll a1.jpg --verify a2.jpg --stranger b.jpg
node scripts/capture-attack-set.mjs   # graba el conjunto de ataque (ver limitación 1)
```

### Qué se prueba, y por qué eso

| Pieza | Casos |
|---|---|
| Perímetro: guards del Gateway | 26 |
| Perímetro: login de administración | 17 |
| Política de acceso, votación, anti-passback, umbral, outbox, evento | 94 |
| Máquina de turnos y parser del bus | 44 |
| Frontend: reglas de `/home` y del listado de personas | 33 |
| Frontend: qué se firma en un parte de relevo | 35 |

Las dos primeras filas son nuevas y tapan una asimetría que el proyecto
arrastraba: se probaba a fondo la **lógica de dominio** y no se probaba
en absoluto el **perímetro de seguridad**, que en un producto de control
de acceso está del revés.

Lo que cubren no es «el guard funciona», sino dos garantías concretas:

- **Un token de sesión facial no sirve para administrar, y uno de
  administración no sirve para `/me`.** La exclusión va en los dos
  sentidos y cada uno tiene su motivo (ADR 0006 y el propio guard de
  sesión). Los tokens de estas pruebas se firman con un `JwtService`
  real: un doble que devolviera un objeto probaría que el guard sabe
  leer un objeto, no que rechaza una firma mala o una caducidad pasada.
- **No se puede enumerar quién es administrador**, ni por el mensaje
  —idéntico siempre— ni por el **tiempo**. Lo segundo es lo frágil: el
  servicio verifica contra un hash de descarte aunque la cuenta no
  exista, y un retorno temprano para correos desconocidos rompería esa
  defensa sin cambiar ni un mensaje.

> **Estos tests se comprobaron rompiendo el código a propósito.** Al
> retirar `payload.typ !== 'admin'` del guard, fallan dos casos. Al
> meter un retorno temprano para correos desconocidos —dejando el
> mensaje de error exactamente igual— falla **uno solo**: justo el que
> vigila la igualación de tiempos. Un test que pasa no demuestra nada
> hasta que se ve fallar por el motivo que dice cubrir.

Ambos servicios exigen **100 % de cobertura** sobre esos archivos en su
`jest.config.js`, y hoy la cumplen en sentencias, ramas, funciones y
líneas.

### El frontend prueba reglas, no estilos

Ni una clase de Tailwind aparece en una aserción. Los estilos cambian
cada vez que alguien ajusta el diseño, y una suite que se rompe al mover
un margen es una suite que la gente deja de ejecutar. Lo que se
comprueba son las **reglas que la interfaz representa**, y dos de ellas
no están escritas en ningún servicio:

- **Qué puede y qué no puede hacer un botón.** Declarar un descanso, sí.
  Fichar la entrada o la salida, jamás: eso lo decide el Access Service
  con una cara delante de una cámara. Y quien está `EN_PAUSA` está
  **fuera del edificio**, así que no puede declarar nada; su vuelta la
  registra la puerta.
- **Los tres estados del rol en el listado.** `null` es «no se pudo
  preguntar al Access Service» y `[]` es «no tiene ninguno».
  Confundirlos marcaría a toda la plantilla en ámbar durante una caída,
  y mandaría a quien administra a asignar roles que ya existen.

> Estos también se comprobaron **rompiéndolos**: al hacer que `EN_PAUSA`
> vuelva a mostrar los botones de descanso falla un test, y solo uno. Al
> tratar `roles: null` como «sin rol», fallan tres.

### Lo que sigue sin tests

El resto de la interfaz: el panel de operación y el asistente de alta
tienen cobertura parcial, y la captura de cámara ninguna. Y el pipeline
de reconocimiento y el enrolamiento, que necesitan imágenes y modelos
reales: la prueba de humo los cubre de extremo a extremo, pero no como
test unitario.

La cobertura global del frontend ronda el 17 %, y eso no es un
descuido: se empezó por donde una regresión silenciosa cuesta caro, no
por subir un porcentaje.

---|---|---|
| Política de acceso (rol · zona · horario) | `access-service/src/policy` | 31 |
| Anti-passback | `access-service/src/presence` | 19 |
| Votación multi-frame | `access-service/src/verification` | 12 |
| Análisis del umbral | `access-service/src/stats` | 13 |
| Contrato del evento de acceso | `access-service/src/presence` | 9 |
| Relay de la outbox | `access-service/src/outbox` | 8 |
| Máquina de estados de turno | `shift-service/src/shifts` | 25 |
| Parser del evento recibido | `shift-service/src/consumer` | 7 |

No es casualidad que todas esas piezas sean **funciones puras o con
dobles**: se diseñaron así precisamente para poder probarlas. Corren en
segundos, sin base de datos y sin contenedores, que es lo que hace que
se ejecuten de verdad en cada cambio.

Lo que **no** tiene pruebas unitarias es el pipeline de reconocimiento y
el enrolamiento, porque necesitan imágenes y modelos reales; la prueba
de humo los cubre de extremo a extremo contra el stack levantado.

---

## Decisiones de arquitectura

Documentadas en [`docs/adr/`](docs/adr/):

| ADR | Decisión |
|---|---|
| 0001 | Prisma en lugar de TypeORM |
| 0002 | rostros.pt como detector + ArcFace para identificar |
| 0003 | Umbral de similitud y votación multi-frame |
| 0004 | Un schema y un rol por servicio |
| 0005 | REST síncrono antes que mensajería |
| 0006 | Autenticación de administradores en un servicio propio |
| 0007 | Redis Streams para los eventos, y la presencia en el Access Service |
| 0008 | Cada servicio es dueño de sus tipos; se retira el paquete de contratos |
| 0009 | Observabilidad con OpenTelemetry, y la traza cruza el bus |
| 0010 | Detección de vida pasiva, y por qué no deniega por defecto |
| 0011 | Voz e IA: el modelo propone, la persona firma |
| 0012 | La bitácora: firmada, inmutable y con el cruce congelado |
| 0013 | El servidor MCP: cliente del Gateway, y de solo lectura |
