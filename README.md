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
   acceso y redirige a la pantalla de bienvenida.
4. Una sección de administración permite registrar personas, capturar su
   rostro y eliminarlas.

**La decisión de acceso se toma íntegramente en el servidor.** El
frontend solo dibuja lo que el backend le dice.

---

## Arquitectura

```
                          ┌──────────────────────────┐
                          │   FRONTEND (React 19)    │
                          │  captura ~5 fps → JPEG   │
                          └────────────┬─────────────┘
                                       │ REST (multipart)
                          ┌────────────▼─────────────┐
                          │   API GATEWAY (NestJS)   │
                          │  el único puerto abierto │
                          └──┬──────────┬────────────┘
              ┌──────────────┘          └──────────────┐
              ▼                                        ▼
  ┌───────────────────────┐              ┌────────────────────────┐
  │    FACE SERVICE       │◄─────────────│    ACCESS SERVICE      │
  │    NestJS + Prisma    │  ¿quién es?  │    NestJS + Prisma     │
  │                       │              │                        │
  │ · personas (CRUD)     │              │ · política de acceso   │
  │ · enrolar rostro      │              │ · votación multi-frame │
  │ · búsqueda pgvector   │              │ · auditoría            │
  └──────────┬────────────┘              │ · emite JWT de sesión  │
             │                           └───────────┬────────────┘
             │ imagen                                │
             ▼                                       │
  ┌───────────────────────┐                          │
  │    VISION SERVICE     │                          │
  │    Python + FastAPI   │                          │
  │      ⚠ SIN ESTADO     │                          │
  │                       │                          │
  │ · rostros.pt → cajas  │                          │
  │ · landmarks → alinear │                          │
  │ · ArcFace → vector    │                          │
  └───────────────────────┘                          │
             │                                       │
             │           ┌───────────────────────────┘
             │           │
             ▼           ▼
        ┌─────────────────────────┐
        │  PostgreSQL + pgvector  │
        │  face_svc · access_svc  │
        └─────────────────────────┘
```

### Responsabilidad de cada servicio

| Servicio | Responsabilidad | Base de datos |
|---|---|---|
| **api-gateway** | Punto de entrada único. Enruta, valida, aplica CORS y rate limiting, normaliza errores. **Cero lógica de reconocimiento.** | — |
| **face-service** | Dueño de las identidades y de los vectores faciales. Enrola, busca y elimina. | schema `face_svc` |
| **access-service** | Decide si se concede el acceso. Votación multi-frame, auditoría, emisión de sesión. | schema `access_svc` |
| **vision-service** | Convierte píxeles en vectores. No conoce identidades ni toca la base de datos. | ninguna |

### Por qué no hay "User Service"

Una persona y su rostro son la misma entidad y siempre se consultan
juntas. Separarlas obligaría a un join distribuido en cada
reconocimiento, que es el camino crítico. Cuando se añadan usuarios
*administradores* (login, roles), eso sí será un servicio aparte: es
otro dominio.

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
│   ├── access-service/       NestJS + Prisma · decisión y auditoría
│   │   └── src/
│   │       ├── verification/ política de acceso y votación
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
│       ├── components/       visor, cajas, diálogo de captura, UI
│       ├── hooks/            cámara y bucle de autenticación
│       └── lib/              cliente de API
│
├── packages/contracts/       DTOs compartidos entre servicios
├── modelos/                  rostros.pt (solo lectura)
├── infrastructure/
│   ├── docker/               Dockerfile común de NestJS
│   └── postgres/init/        schemas, roles y permisos
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
`ACCESS_SVC_DB_PASSWORD` y `JWT_SECRET`.

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
| `ADMIN_AUTH_ENABLED` | `false` | Activa el guard de administrador |

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
| PostgreSQL | `127.0.0.1:5432` (solo local) |

Aplica las migraciones la primera vez:

```bash
docker compose exec face-service npx prisma migrate deploy
docker compose exec access-service npx prisma migrate deploy
```

---

## Ejecución local (desarrollo)

Cada servicio en su propia terminal.

**1. PostgreSQL**

```bash
docker compose up postgres -d
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

**5. API Gateway**

```bash
cd api-gateway
npm install
npm run start:dev
```

**6. Frontend**

```bash
cd frontend
npm install
npm run dev
```

Abre http://localhost:5173.

> La cámara del navegador exige un contexto seguro. `localhost` cuenta
> como tal; si sirves desde otra IP necesitarás HTTPS.

---

## Cómo registrar una persona

1. Entra en **http://localhost:5173/admin/faces**.
2. Escribe el nombre (y opcionalmente un identificador) y pulsa *Crear*.
3. Se abre la captura automáticamente. Colócate de frente, con buena luz.
4. Pulsa *Capturar*, revisa la imagen y pulsa *Registrar*.
5. El backend detecta el rostro, genera el vector y lo asocia a la
   persona. **La fotografía se descarta.**

El registro se rechaza si: no hay rostro, hay más de uno, la calidad es
baja, o el rostro aparece cortado. Cada rechazo indica el motivo.

Puedes registrar varios rostros por persona (distintas condiciones de
luz o gafas) para mejorar el reconocimiento.

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
`PERSON_SUSPENDED`.

### Administración

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/admin/persons` | Lista personas (`?search=`, `?skip=`, `?take=`) |
| `POST` | `/admin/persons` | Crea una persona |
| `GET` | `/admin/persons/:id` | Consulta una persona |
| `PATCH` | `/admin/persons/:id` | Cambia nombre o estado |
| `DELETE` | `/admin/persons/:id` | Elimina y **borra sus vectores** |
| `POST` | `/admin/persons/:id/faces` | Enrola un rostro (multipart) |
| `GET` | `/admin/access-logs` | Historial de intentos |
| `GET` | `/health` | Estado de todos los servicios |

**Ningún endpoint devuelve embeddings.**

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

face_svc.admin_users
  id · email · password_hash (argon2id) · display_name · is_active

access_svc.access_logs
  id · person_id · person_name · authenticated · confidence · reason
  camera_id · session_id · created_at

access_svc.access_sessions
  id · person_id · person_name · issued_at · expires_at · revoked_at
```

**`model_version` no es burocracia:** los embeddings de modelos
distintos ocupan espacios vectoriales incompatibles. Sin esa columna, un
cambio de modelo rompería el reconocimiento de forma silenciosa.

**`person_name` duplicado en `access_logs` es intencionado:** un asiento
de auditoría debe ser inmutable y seguir describiendo lo que pasó aunque
la persona se renombre o se elimine.

---

## Consideraciones de seguridad

### Lo que está implementado

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

### Lo que NO está implementado

Estas limitaciones son reales y deben conocerse antes de usar el sistema
en producción.

#### 1. Sin detección de vida (anti-spoofing) — la más importante

**Una fotografía en la pantalla de un móvil superaría la
autenticación.** La votación multi-frame evita el falso positivo
puntual, pero no distingue una cara real de una impresa.

El sistema **no es apto para control de acceso real** hasta añadirlo. La
arquitectura está preparada: el paso 8 del pipeline (votación) es donde
se enchufa, porque ya acumula frames consecutivos.

Ampliaciones previstas: detección de vida pasiva, verificación de
textura/reflejos, análisis de micromovimiento, cámara con profundidad o
infrarrojos.

#### 2. Administración sin autenticación

`ADMIN_AUTH_ENABLED=false` por defecto: `/admin/*` está abierto.
Cualquiera con acceso a la red puede registrar o eliminar personas.

El guard está escrito y la tabla `admin_users` existe; falta el endpoint
de login. **Debe activarse antes de exponer el sistema.**

#### 3. Estado de votación en memoria

Las ventanas viven en el proceso del Access Service. Con varias réplicas
haría falta Redis o afinidad de sesión.

#### 4. Umbral sin calibrar con datos reales

`0.38` es un valor conservador basado en la separación medida sobre las
imágenes de prueba de InsightFace. **Debe calibrarse con rostros y
cámara reales** antes de producción.

#### 5. Embeddings sin cifrar en reposo

Se guardan en claro. Existen ataques de reconstrucción facial a partir
de embeddings, así que en producción conviene cifrado a nivel de columna
o de disco.

#### 6. Sin HTTPS

La configuración es de desarrollo. En producción hacen falta TLS y un
proxy inverso: la cámara exige contexto seguro fuera de `localhost`.

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

## Decisiones de arquitectura

Documentadas en [`docs/adr/`](docs/adr/):

| ADR | Decisión |
|---|---|
| 0001 | Prisma en lugar de TypeORM |
| 0002 | rostros.pt como detector + ArcFace para identificar |
| 0003 | Umbral de similitud y votación multi-frame |
| 0004 | Un schema y un rol por servicio |
| 0005 | REST síncrono antes que mensajería |
