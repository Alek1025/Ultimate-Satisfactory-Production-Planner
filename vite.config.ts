import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app lives in app/; the parser, solver and plan store in src/ are imported directly.
// Everything is bundled locally (fonts, HiGHS WASM): no network access at runtime.
export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  // Pre-bundle up front: otherwise the dev server finds HiGHS only when the worker starts and reloads the page once.
  optimizeDeps: { include: ['react', 'react-dom/client', 'highs', 'fflate'] },
  build: { outDir: '../dist-app', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { port: 4173, fs: { allow: ['..'] } },
  preview: { port: 4173 },
});
