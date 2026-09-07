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
  },
});
