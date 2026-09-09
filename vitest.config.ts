import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'frontend/src') },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./frontend/src/test/setup.ts'],
    include: ['frontend/src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'scripts/smoke.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['frontend/src/**/*.{ts,tsx}'],
      exclude: ['frontend/src/**/*.{test,spec}.{ts,tsx}', 'frontend/src/test/**'],
    },
  },
});
