import 'dotenv/config';
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
