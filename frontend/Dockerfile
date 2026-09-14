# ══════════════════════════════════════════════════════════════════
#  Frontend — build de Vite servido por nginx
# ══════════════════════════════════════════════════════════════════

FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Vite incrusta las variables VITE_* en el bundle durante la
# construcción, así que deben llegar como ARG y no como variables de
# ejecución del contenedor.
# RELATIVA a proposito. nginx sirve /api/ en el mismo origen que la
# pagina (ver nginx.conf), asi que la aplicacion funciona desde
# cualquier maquina de la red y no solo desde la que corre Docker. Una
# URL absoluta a localhost ataba el bundle a UN equipo.
ARG VITE_API_BASE_URL=/api/v1
ARG VITE_CAPTURE_FPS=5
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_CAPTURE_FPS=${VITE_CAPTURE_FPS}

RUN npm run build


FROM nginx:1.29-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# No es un `server` suelto: es el fragmento que cada `location` incluye.
# nginx no hereda `add_header` hacia dentro, y tenerlo en un archivo
# evita que las cuatro cabeceras se dupliquen -y se desincronicen- en
# los cuatro bloques.
COPY security-headers.conf /etc/nginx/conf.d/security-headers.conf

EXPOSE 80

# Se comprueba contra 127.0.0.1 y no contra `localhost`: dentro del
# contenedor, localhost resuelve primero a ::1 (IPv6) y nginx solo
# escucha en IPv4, asi que la comprobacion daria "connection refused"
# aunque el servidor este perfectamente sano.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
