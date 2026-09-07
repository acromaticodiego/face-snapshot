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
ARG VITE_API_BASE_URL=http://localhost:3000/api/v1
ARG VITE_CAPTURE_FPS=5
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_CAPTURE_FPS=${VITE_CAPTURE_FPS}

RUN npm run build


FROM nginx:1.29-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Se comprueba contra 127.0.0.1 y no contra `localhost`: dentro del
# contenedor, localhost resuelve primero a ::1 (IPv6) y nginx solo
# escucha en IPv4, asi que la comprobacion daria "connection refused"
# aunque el servidor este perfectamente sano.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
