import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  server: {
    port: 5173,
    // La cámara del navegador exige un contexto seguro. localhost cuenta
    // como tal, así que en desarrollo no hace falta HTTPS.
    host: true,
    // El mismo /api que sirve nginx en el contenedor, para que la
    // dirección relativa funcione también con `npm run dev`. Sin esto,
    // una petición a /api/v1 se la comería el propio Vite y devolvería
    // el index.html de la SPA con un 200, que es la forma más confusa
    // posible de fallar: la aplicación no vería un error de red, vería
    // HTML donde esperaba JSON.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
