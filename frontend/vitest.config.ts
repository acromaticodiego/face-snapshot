import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Configuración de Vitest.
 *
 * POR QUE UN ARCHIVO APARTE Y NO DENTRO DE vite.config.ts
 * ──────────────────────────────────────────────────────
 * Porque `vite.config.ts` carga el plugin de Tailwind, que en el
 * entorno de test no pinta nada y solo añade tiempo de arranque a cada
 * ejecución. Lo que hace que unos tests se corran de verdad es que sean
 * rápidos; aquí se deja lo mínimo para montar componentes de React.
 *
 * NO SE INTENTA COMPROBAR COMO SE VE NADA
 * ───────────────────────────────────────
 * Estas pruebas no miran estilos ni clases de Tailwind: eso cambia cada
 * vez que alguien ajusta el diseño y romper la suite por mover un
 * margen es la forma más rápida de que la gente deje de ejecutarla. Lo
 * que se comprueba son las REGLAS que la interfaz representa: qué
 * controles existen en cada estado, qué texto se le enseña a quién, y
 * qué cuenta la línea de tiempo.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
    },
  },
});
