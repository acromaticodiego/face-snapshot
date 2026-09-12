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
 * Configuración de Prisma 7.
 *
 * A partir de la versión 7, la URL de conexión ya NO se declara en
 * `schema.prisma`: vive aquí para las migraciones, y el cliente en
 * tiempo de ejecución recibe un adaptador de driver (ver
 * `src/prisma/prisma.service.ts`).
 *
 * El cambio es una mejora de seguridad: el schema puede versionarse sin
 * arrastrar credenciales, ni siquiera como referencia a variables.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.AUTH_DATABASE_URL!,
  },
});
