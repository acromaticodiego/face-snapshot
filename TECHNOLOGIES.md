# Technologies

Todas las versiones de este documento corresponden a lo **realmente
instalado** en el proyecto: se extrajeron de los `package-lock.json` y
del entorno virtual de Python, no de la documentación de cada paquete.

Última verificación: 2026-09-07.

---

## Frontend

| Technology | Version | Purpose | Service |
|---|---|---|---|
| React | 19.2.8 | Librería de interfaz | frontend |
| React DOM | 19.2.8 | Renderizado en navegador | frontend |
| TypeScript | 5.9.3 | Lenguaje | frontend |
| Vite | 8.2.2 | Build y servidor de desarrollo | frontend |
| React Router | 7.18.3 | Enrutado y redirección post-login | frontend |
| Tailwind CSS | 4.3.3 | Sistema de estilos | frontend |
| @tailwindcss/vite | 4.3.3 | Integración de Tailwind 4 con Vite | frontend |
| @vitejs/plugin-react | 6.1.1 | Fast Refresh y JSX | frontend |
| lucide-react | 1.42.0 | Iconos | frontend |
| sonner | 2.0.8 | Notificaciones (toasts) | frontend |
| clsx | 2.1.1 | Composición de clases | frontend |
| tailwind-merge | 3.6.0 | Resolución de clases en conflicto | frontend |

**Por qué Tailwind 4 y no shadcn/ui:** shadcn/ui aporta componentes ya
hechos, pero arrastra Radix UI y su propio sistema de tokens. Esta
aplicación tiene tres pantallas y un puñado de componentes; el coste de
mantener esa dependencia supera el ahorro. Los componentes están en
`frontend/src/components/ui/`, se leen en cinco minutos y no dependen de
nadie.

---

## Backend

| Technology | Version | Purpose | Service |
|---|---|---|---|
| Node.js | 24.19.0 | Runtime | gateway, face, access, auth |
| npm | 11.17.0 | Gestor de paquetes | gateway, face, access |
| NestJS (core/common) | 11.2.3 | Framework | gateway, face, access, auth |
| @nestjs/platform-express | 11.2.3 | Servidor HTTP | gateway, face, access |
| @nestjs/config | 4.0.4 | Variables de entorno | gateway, face, access |
| @nestjs/swagger | 11.4.7 | OpenAPI y documentación | gateway, face, access |
| @nestjs/throttler | 6.5.0 | Rate limiting | gateway, face, access |
| @nestjs/jwt | 11.0.2 | Tokens de sesión y de administración | gateway, access, auth |
| TypeScript | 5.9.3 | Lenguaje | gateway, face, access |
| Prisma CLI | 7.10.0 | Migraciones | face, access, auth |
| @prisma/client | 7.10.0 | ORM | face, access, auth |
| @prisma/adapter-pg | 7.10.0 | Adaptador de driver (obligatorio en Prisma 7) | face, access |
| pg | 8.23.0 | Driver PostgreSQL | face, access |
| Zod | 4.5.4 | Validación y contratos compartidos | todos |
| Axios | 1.20.0 | Cliente HTTP entre servicios | gateway, face, access |
| Helmet | 8.3.0 | Cabeceras de seguridad | gateway, face, access, auth |
| @node-rs/argon2 | 2.2.0 | Hash de contraseñas (argon2id) | auth |
| form-data | 4.0.6 | Reenvío multipart entre servicios | gateway, face, access |

---

## Vision

| Technology | Version | Purpose | Service |
|---|---|---|---|
| Python | 3.12.0 | Runtime | vision-service |
| FastAPI | 0.141.1 | API HTTP | vision-service |
| Uvicorn | 0.52.4 | Servidor ASGI | vision-service |
| Pydantic | 2.13.5 | Esquemas y validación | vision-service |
| pydantic-settings | 2.13.0 | Configuración por entorno | vision-service |
| PyTorch | 2.14.0+cpu | Framework para cargar rostros.pt | vision-service |
| TorchVision | 0.29.0+cpu | Dependencia de Ultralytics | vision-service |
| Ultralytics | 8.4.141 | Ejecución del modelo YOLOv8 | vision-service |
| InsightFace | 1.0.1 | Landmarks faciales y ArcFace | vision-service |
| onnxruntime | 1.29.0 | Inferencia ONNX en CPU | vision-service |
| NumPy | 2.5.2 | Álgebra de vectores | vision-service |
| opencv-python-headless | 5.0.0.93 | Decodificación y métricas de imagen | vision-service |
| Pillow | 12.3.0 | Soporte de formatos de imagen | vision-service |
| structlog | 25.5.0 | Logging estructurado | vision-service |
| python-multipart | 0.0.20 | Subida de archivos | vision-service |

### Modelos

| Model | Origin | Purpose |
|---|---|---|
| `rostros.pt` | Propio (YOLOv8s, 40 epochs, dataset `Rostros-1`) | Detección facial. 1 clase: `rostro` |
| `buffalo_l/2d106det` | InsightFace | 106 landmarks faciales, para alinear |
| `buffalo_l/w600k_r50` | InsightFace | Embeddings ArcFace de 512-d |

**Nota sobre `rostros.pt`:** se verificó con
`services/vision-service/scripts/inspect_model.py`. Es un **detector**,
no un clasificador de identidades: tiene una única clase y cabeza
`Detect`, por lo que no entrega landmarks. Esa es la razón de que el
pipeline incluya un modelo de landmarks entre la detección y el
embedding.

---

## Database

| Technology | Version | Purpose |
|---|---|---|
| PostgreSQL | 17 (imagen `pgvector/pgvector:pg17`) | Base de datos |
| pgvector | incluida en la imagen | Tipo `vector` y búsqueda por similitud |

---

## Infrastructure

| Technology | Version | Purpose |
|---|---|---|
| Docker Engine | 29.7.2 | Contenedores |
| Docker Compose | v5.4.0 | Orquestación |
| nginx | 1.29-alpine | Servidor estático del frontend |
| Git | 2.55.0 | Control de versiones |

---

## Incompatibilidades encontradas y cómo se resolvieron

Estas no son hipótesis: son fallos reales que aparecieron al instalar.

### 1. NestJS 12 no es compatible con `@nestjs/throttler`

`npm view @nestjs/core version` devuelve **12.0.1**, pero la instalación
fallaba con `ERESOLVE`:

```
@nestjs/throttler@6.5.0 peerDependencies:
  @nestjs/common: ^7 || ^8 || ^9 || ^10 || ^11     ← no incluye ^12
```

**Resolución:** todo el backend se fijó en **NestJS 11.2.3**, donde el
ecosistema completo (throttler, swagger, jwt, config) encaja sin forzar
nada. Se descartó `--legacy-peer-deps`: silencia el aviso pero deja el
árbol de dependencias en un estado que nadie ha probado.

También obligó a usar **`@nestjs/config` 4.0.4** en lugar de la 12.0.0
que devuelve `latest`, porque la 12 exige `@nestjs/common ^11 || ^12` y
la línea 4.x es la que corresponde a Nest 11.

### 2. El tag `latest` de Prisma apunta a una release candidate

```
npm view prisma dist-tags
  latest: 8.0.0-rc.13     ← candidata, no estable
  prev:   7.10.0          ← estable
```

**Resolución:** `prisma` y `@prisma/client` fijados ambos en **7.10.0**.
Instalar sin fijar habría dejado el CLI en la versión 8 RC y el cliente
en la 7, desalineados.

### 3. Prisma 7 eliminó `url` del bloque `datasource`

```
error: The datasource property `url` is no longer supported in schema files.
```

Es un cambio de diseño de la versión 7, no un fallo.

**Resolución:** la URL de conexión se movió a `prisma.config.ts` (para
las migraciones) y el cliente en tiempo de ejecución recibe un
`PrismaPg` adapter construido en `PrismaService`. Efecto colateral
positivo: el `schema.prisma` versionado ya no contiene ninguna
referencia a credenciales.

### 4. TypeScript 7 no está soportado por NestJS

`npm view typescript version` devuelve **7.0.2**, una reescritura mayor
del compilador que NestJS 11 y su cadena de decoradores no declaran
soportar.

**Resolución:** fijado **TypeScript 5.9.3**, el estable de la línea 5.x.
Revisar cuando el ecosistema de Nest lo soporte.

### 5. `@types/express` y `@types/node`

Las versiones que se habían anotado inicialmente (`5.0.7`, `24.10.1`) no
existen en el registro. **Resolución:** consultadas y fijadas en las
reales: `@types/express` **5.0.6** y `@types/node` **26.5.0**.

### 6. Aviso de scikit-image en `face_align`

InsightFace llama a `SimilarityTransform.estimate()`, que scikit-image
0.26 marca como obsoleto:

```
FutureWarning: `estimate` is deprecated since version 0.26
```

**Estado:** es solo un aviso; la alineación funciona correctamente y se
validó midiendo los embeddings resultantes. No se fija una versión
anterior de scikit-image por un warning. A vigilar cuando salga
scikit-image 2.2, donde el método desaparecerá.

---

## Versiones descartadas a propósito

| Package | `latest` | Usada | Motivo |
|---|---|---|---|
| `@nestjs/core` | 12.0.1 | 11.2.3 | throttler no soporta la 12 |
| `@nestjs/config` | 12.0.0 | 4.0.4 | requiere Nest 11+ como par de la 12 |
| `prisma` | 8.0.0-rc.13 | 7.10.0 | `latest` es una release candidate |
| `typescript` | 7.0.2 | 5.9.3 | NestJS no declara soporte para TS 7 |

---

## Nota sobre argon2

Se usa `@node-rs/argon2` (implementación en Rust) y no el paquete
`argon2` clásico porque distribuye **binarios precompilados para musl**,
la librería de C de Alpine. El paquete clásico exige compilar con
node-gyp, lo que obligaría a instalar `build-base` y `python3` en la
imagen de producción solo para hashear contraseñas.

Parámetros usados, según la recomendación de OWASP para argon2id:

| Parámetro | Valor |
|---|---|
| memoryCost | 19 456 KiB (19 MiB) |
| timeCost | 2 iteraciones |
| parallelism | 1 |
