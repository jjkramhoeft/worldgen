import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5199, strictPort: true },
  preview: { port: 5198 },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
