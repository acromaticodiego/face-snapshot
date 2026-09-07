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

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
