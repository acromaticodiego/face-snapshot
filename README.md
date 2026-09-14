# Control de Acceso Facial

Sistema de control de acceso y asistencia que identifica personas por su
rostro. Detección con un modelo YOLO propio, identificación con
embeddings ArcFace, búsqueda vectorial en PostgreSQL, y detección de
vida validada contra un conjunto de ataque real.

Arquitectura de microservicios, funcionando de extremo a extremo.

---

## Qué hace

Una persona se pone frente a la cámara. El sistema la identifica, decide
si puede entrar según su **rol, la zona y el horario**, y registra el
paso. A partir de ahí lleva su **jornada laboral**: entradas, descansos,
salidas y horas trabajadas.

Además incluye:

- **Detección de vida.** Una foto en la pantalla de un móvil no abre la
  puerta.
- **Anti-passback.** No se puede entrar dos veces sin haber salido.
- **Panel de operación.** Aforo en tiempo real, denegaciones por motivo,
  distribución de similitudes frente al umbral y mapa de actividad.
- **Bitácora de relevo por voz.** El vigilante dicta las novedades al
  acabar el turno y un LLM las estructura en incidencias; la persona
  revisa y firma.
- **Servidor MCP.** Permite preguntarle al sistema en lenguaje natural
  quién está dentro o qué quedó pendiente.

La decisión de acceso se toma **íntegramente en el servidor**. El
frontend solo dibuja lo que el backend le dice.

---

## Arquitectura

```
                    ┌─────────────────────────┐
                    │   FRONTEND (React 19)   │
                    │   captura ~5 fps        │
                    └───────────┬─────────────┘
                                │ REST
                    ┌───────────▼─────────────┐
                    │   API GATEWAY (NestJS)  │
                    │   el único puerto abierto│
                    └─┬────────┬────────┬─────┘
          ┌───────────┘        │        └────────────┐
          ▼                    ▼                     ▼
   ┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
   │AUTH SERVICE │     │ FACE SERVICE │◄────│  ACCESS SERVICE  │
   │ login admin │     │ identidades  │     │ DECIDE EL ACCESO │
   └─────────────┘     │ + vectores   │     │ política · votos │
                       └──────┬───────┘     │ anti-passback    │
                              │ imagen      │ presencia        │
                              ▼             └────────┬─────────┘
                    ┌──────────────────┐             │ evento (outbox)
                    │  VISION SERVICE  │             ▼
                    │ Python · SIN BD  │      ┌─────────────┐
                    │ YOLO · ArcFace   │      │    REDIS    │
                    │ MiniFASNet       │      │   Streams   │
                    └──────────────────┘      └──────┬──────┘
                                                     ▼
   ┌──────────────┐    ┌─────────────────┐   ┌─────────────────┐
   │VOICE SERVICE │───►│ LOGBOOK SERVICE │   │  SHIFT SERVICE  │
   │Python·SIN BD │    │ partes firmados │   │ jornada laboral │
   │Deepgram+LLM  │    │   inmutables    │   │  ⚠ PROYECCIÓN   │
   └──────────────┘    └─────────────────┘   └─────────────────┘
                                │                     │
   ┌────────────────────────────▼─────────────────────▼────────┐
   │                 PostgreSQL 17 + pgvector                   │
   │      un schema y un ROL DE BASE DE DATOS por servicio      │
   └────────────────────────────────────────────────────────────┘
```

Tres decisiones que explican el diseño:

**El Vision Service no tiene estado ni base de datos.** Convierte
píxeles en vectores y nada más. No sabe de quién es la cara que analiza.

**El Shift Service es una proyección, no una autoridad.** Los eventos
viajan en un solo sentido a través de una *outbox* transaccional y Redis
Streams. Si se cae, las puertas siguen abriendo y los eventos esperan.

**El aislamiento lo impone PostgreSQL, no el código.** `face_svc_user`
no puede leer `access_svc` aunque su código lo intentara.

---

## El reconocimiento, paso a paso

```
frame JPEG
  → rostros.pt (YOLOv8s)      detección
  → filtro de calidad         descarta cara pequeña, borrosa o cortada
  → 2d106det                  landmarks → 5 puntos canónicos
  → alineación                recorte 112×112
  → ArcFace w600k_r50         vector 512-d, norma L2
  → pgvector                  búsqueda por similitud coseno
  → umbral 0.38
  → votación 3 de 5 frames    → ACCESO
```

**Medido, no estimado** (6 rostros etiquetados a mano):

| | Similitud coseno |
|---|---|
| Misma persona | 0.49 – 0.99 |
| Personas distintas (15 pares) | −0.08 – 0.24 |

---

## Detección de vida

La decide **MiniFASNet**, sobre el frame original. Medida sobre 40 caras
reales y 38 fotos de esas caras en la pantalla de un móvil, con la misma
webcam y **sin ajustar ningún umbral**:

| | cara real | pantalla |
|---|---|---|
| puntuación | 0.985 ± 0.040 | 0.119 ± 0.152 |
| peor caso | **0.777** | **0.539** |

Entre esos dos valores no cae ninguna de las 78 imágenes. Con el umbral
en 0.60: **APCER 0 %, BPCER 0 %**, y **9.2 ms** por rostro frente a los
~740 ms del detector.

La señal anterior —espectral— se retiró después de medirla: daba 0 % de
error dentro de su tanda de captura y 25 % / 20 % al aplicarla a otra.
La autopsia está en el
[ADR 0014](docs/adr/0014-modelo-de-deteccion-de-vida.md).

**Por defecto no deniega el paso**, solo anota la sospecha. El conjunto
con el que se midió es de una persona y un móvil: falta foto impresa,
vídeo en pantalla y máscara.

---

## Tecnologías

| Capa | Stack |
|---|---|
| Frontend | React 19, Vite, TypeScript, Tailwind 4 |
| Gateway y servicios de dominio | NestJS 11, Prisma |
| Visión y voz | Python 3.12, FastAPI |
| Modelos | YOLOv8s (propio), ArcFace `w600k_r50`, MiniFASNet, 2d106det |
| Voz e IA | Deepgram (transcripción), Gemini (estructuración), MCP |
| Datos | PostgreSQL 17 + pgvector (índice HNSW), Redis 8 Streams |
| Observabilidad | OpenTelemetry → Collector → Tempo, Prometheus, Grafana |
| Infraestructura | Docker Compose, nginx, TLS |

---

## Arrancar

```bash
cp .env.example .env     # rellenar contraseñas y JWT_SECRET
docker compose up --build
```

La primera construcción descarga PyTorch y los modelos (~700 MB).

| | |
|---|---|
| Interfaz | http://localhost:5173 |
| Swagger del Gateway | http://localhost:3000/docs |
| Grafana | http://localhost:3001 |

Para usarlo desde otro dispositivo hace falta HTTPS, porque la cámara
del navegador solo funciona en contexto seguro:

```bash
node scripts/generate-tls-cert.mjs
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
```

---

## Privacidad

- **No se guarda ninguna imagen facial.** Ni al enrolar ni al
  autenticar. Solo el vector.
- **Los embeddings nunca salen del backend**, garantizado por el sistema
  de tipos.
- **Los logs y las trazas no contienen datos biométricos.**
- **Borrar una persona elimina físicamente sus vectores.**

La bitácora por voz es la excepción declarada: manda audio a Deepgram y
texto a Google, y la voz también es un dato biométrico. El audio no se
almacena en ningún sitio.

---

## Limitaciones

Están documentadas en detalle porque un sistema que se usa para abrir
puertas tiene que decir la verdad sobre sí mismo.

**El sistema no es apto para control de acceso real todavía.** La
detección de vida está validada contra un solo tipo de ataque. Faltan,
como mínimo, foto impresa y vídeo reproducido en pantalla.

Y el margen del umbral de reconocimiento es más estrecho de lo que
parecía: 0.2552 de separación entre nubes con fotos de archivo frente a
**0.0641** con los accesos reales del despliegue. El umbral sigue
separando, pero con tres centésimas de margen.

La lista completa —revocación de tokens, cifrado de embeddings en
reposo, escalado horizontal del consumidor— está en el README extendido
y en las **14 ADRs** de [`docs/adr/`](docs/adr/), que incluyen las
decisiones que resultaron estar equivocadas y por qué.

---

## Cómo está probado

**~300 casos** que corren en segundos y sin contenedores: política de
acceso, votación, anti-passback, máquina de estados de turnos, los dos
guards del perímetro, la aritmética del medidor de vida y las reglas de
la interfaz.

Los tests se **rompen a propósito** para comprobar que fallan por el
motivo que dicen cubrir. Eso encontró un medidor que declaraba «la señal
separa» habiendo medido cero muestras, y un test que salía por un guarda
de entrada sin llegar nunca al camino del error.
