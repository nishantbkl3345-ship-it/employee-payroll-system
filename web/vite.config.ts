import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.VITE_API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/healthz': { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
