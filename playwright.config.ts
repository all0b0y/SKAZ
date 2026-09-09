import { defineConfig } from '@playwright/test';

// Desktop (Electron) smoke only. The renderer must be built first
// (`npm run build`); the smoke script wires that up.
export default defineConfig({
  testDir: './scripts',
  testMatch: /smoke\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
});
