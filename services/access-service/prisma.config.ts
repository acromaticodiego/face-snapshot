import 'dotenv/config';
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
