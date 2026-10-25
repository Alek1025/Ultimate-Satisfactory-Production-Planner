import { defineConfig } from 'vitest/config';

// Tests run from the repo root (vite.config.ts points Vite at app/).
export default defineConfig({ root: '.', test: { include: ['test/**/*.test.ts'] } });
