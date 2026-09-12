import { config as loadEnv } from 'dotenv';

// El .env del propio servicio primero, y el de la raiz despues como
// respaldo. dotenv no sobreescribe lo que ya esta definido, asi que el
// local gana; sin la segunda linea, un clon recien hecho no puede
// aplicar migraciones hasta crear a mano un .env por servicio que no
// esta documentado en ninguna parte.
loadEnv();
loadEnv({ path: '../../.env' });
import { defineConfig } from 'prisma/config';

/**
 * Configuración de Prisma 7 del Access Service.
 * Ver el comentario equivalente en face-service/prisma.config.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.ACCESS_DATABASE_URL!,
  },
});
