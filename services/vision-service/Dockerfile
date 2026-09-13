# ══════════════════════════════════════════════════════════════════
#  Vision Service — detección con rostros.pt + embeddings ArcFace
#
#  Construcción en dos etapas: las dependencias se compilan en la etapa
#  `builder` y solo el entorno virtual resultante pasa a la imagen
#  final. Así los compiladores y las cabeceras de desarrollo no viajan
#  a producción.
# ══════════════════════════════════════════════════════════════════

FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# build-essential y cmake los necesita insightface para compilar sus
# extensiones nativas. No se incluyen en la imagen final.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .

# PyTorch desde el índice de CPU: la variante por defecto arrastra las
# librerías de CUDA (varios GB) que aquí no se usan.
RUN pip install --upgrade pip \
    && pip install torch==2.14.0 torchvision==0.29.0 \
         --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements.txt

# Ultralytics declara `opencv-python`, la variante CON interfaz gráfica.
# Se instala junto a la headless y es la que acaba resolviendo `import
# cv2`, pero enlaza contra libxcb y el resto de X11, que no existen en
# una imagen slim.
#
# Se desinstalan ambas y se reinstala solo la headless: es la correcta
# para un servidor sin pantalla, y evita arrastrar X11 entero a la imagen
# solo para satisfacer una dependencia que nunca dibuja una ventana.
RUN pip uninstall -y opencv-python opencv-python-headless \
    && pip install --no-cache-dir opencv-python-headless==5.0.0.93 \
    && python -c "import cv2; print('cv2', cv2.__version__, 'headless OK')"


# ── Imagen final ──────────────────────────────────────────────────
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" \
    # InsightFace descarga aquí sus modelos ONNX.
    INSIGHTFACE_HOME=/opt/models/.insightface

# libglib y libgomp son dependencias de tiempo de ejecución de OpenCV y
# onnxruntime. Sin ellas, el import falla dentro del contenedor.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 \
      libgomp1 \
      curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

# Usuario sin privilegios: el servicio procesa imágenes que llegan de
# fuera, así que no debe correr como root.
RUN useradd --create-home --shell /bin/bash vision \
    && mkdir -p /opt/models \
    && chown -R vision:vision /opt/models

WORKDIR /app
COPY --chown=vision:vision app ./app
COPY --chown=vision:vision scripts ./scripts

USER vision

# Se descargan los modelos de InsightFace durante la construcción: si se
# dejara para el arranque, el primer reconocimiento tardaría minutos y
# el contenedor necesitaría salida a Internet en producción.
RUN python -c "from insightface.utils import storage; storage.ensure_available('models', 'buffalo_l')"

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:8000/api/v1/health || exit 1

# ══════════════════════════════════════════════════════════════════
#  NUMERO DE PROCESOS: MEDIDO, NO SUPUESTO
#
#  El valor por defecto es UN worker, y es el resultado de medirlo, no
#  una decision por comodidad. La intuicion decia que varios procesos
#  multiplicarian el rendimiento: cada uno tiene su copia de los
#  modelos, asi que esquivan de golpe el GIL y el candado que protege a
#  ultralytics. La medida dice otra cosa (mediana de 7 repeticiones,
#  4 peticiones simultaneas, 12 nucleos):
#
#      1 worker x 6 hilos ....  2.28 frames/s  [2.15-2.64]   609 MiB
#      2 workers x 6 hilos ...  2.40 frames/s  [2.02-2.65]  1.10 GiB
#
#  Los rangos se solapan: el segundo proceso no compra nada
#  distinguible del ruido, y cuesta casi el doble de memoria. El motivo
#  es que una sola inferencia de torch ya usa 6 de los 12 nucleos, asi
#  que la maquina esta practicamente saturada con un solo worker
#  solapando trabajo. Repartir mas fino es peor: con 4 workers x 3
#  hilos la latencia de una peticion sube de 570 ms a 964 ms, porque
#  cada inferencia se queda sin nucleos.
#
#  Se deja como variable porque en una maquina con mas nucleos la
#  respuesta puede cambiar. Lo que no se debe hacer es subirlo sin
#  volver a medir.
#
#  Y OJO CON LOS HILOS: torch coge por defecto la mitad de los nucleos
#  para UNA inferencia. Con varios workers sin fijar este limite, todos
#  piden todos los nucleos y se estorban.
#
#  Va en UNA sola linea a proposito: este archivo tiene finales de
#  linea CRLF y el parser de Docker no acepta la continuacion con
#  barra cuando le sigue un retorno de carro. Partirla en varias
#  lineas rompe la construccion con 'unknown instruction: exec'.
# ══════════════════════════════════════════════════════════════════
CMD [ -n "${VISION_THREADS_PER_WORKER:-}" ] && export OMP_NUM_THREADS="$VISION_THREADS_PER_WORKER"; exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${VISION_WORKERS:-1}
