# ══════════════════════════════════════════════════════════════════
#  Voice Service — transcripcion (Deepgram) y estructuracion (Gemini)
#
#  Mismo patron que el Vision Service: las dependencias se instalan en
#  la etapa `builder` y solo el entorno virtual pasa a la imagen final.
#
#  La diferencia con aquel es el tamano, y viene de que aqui NO se
#  carga ningun modelo: el trabajo pesado lo hacen dos servicios ajenos
#  al otro lado de la red. Eso tambien explica por que este contenedor
#  arranca en milisegundos y aquel tarda en estar listo.
# ══════════════════════════════════════════════════════════════════

FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt


# ── Imagen final ──────────────────────────────────────────────────
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH"

# curl solo para el HEALTHCHECK. No hay dependencias nativas que
# instalar: sin OpenCV ni onnxruntime, no hace falta ni libglib ni
# libgomp.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

# Usuario sin privilegios: este servicio recibe audio de fuera y habla
# con terceros, asi que no debe correr como root.
#
# Se llama `voicesvc` y no `voice` porque Debian YA trae un grupo de
# sistema llamado `voice` -de los tiempos de los modems- y `useradd`
# falla con codigo 9 al intentar crear el grupo homonimo. Meter al
# usuario en ese grupo del sistema seria peor que renombrarlo.
RUN useradd --create-home --shell /bin/bash --user-group voicesvc

WORKDIR /app
COPY --chown=voicesvc:voicesvc app ./app
COPY --chown=voicesvc:voicesvc tests ./tests

USER voicesvc

EXPOSE 8001

# El periodo de gracia es corto -10 s- porque aqui no hay modelos que
# cargar. Si este servicio no responde en ese plazo, no es que este
# arrancando: es que algo va mal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8001/api/v1/health || exit 1

# UN worker basta y no hay nada que medir aqui: el proceso no hace
# trabajo de CPU, solo espera a dos APIs. Con manejadores async, un
# solo proceso atiende muchas peticiones en vuelo a la vez, y anadir
# workers solo multiplicaria la memoria.
#
# En UNA linea, igual que el Vision Service: este archivo tiene finales
# de linea CRLF y el parser de Docker no acepta la continuacion con
# barra cuando le sigue un retorno de carro.
CMD exec uvicorn app.main:app --host 0.0.0.0 --port 8001 --workers ${VOICE_WORKERS:-1}
