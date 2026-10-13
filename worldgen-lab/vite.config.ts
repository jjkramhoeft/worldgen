import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build also works from a sub-path such as GitHub Pages' /worldgen/.
  base: './',
  server: { port: 5199, strictPort: true },
  preview: { port: 5198 },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
