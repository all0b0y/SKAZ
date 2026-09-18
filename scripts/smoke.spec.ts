import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

// Desktop smoke: launches the packaged main process against the built renderer,
// with a fake audio device so mic capture can run in automation. It verifies the
// real shell renders and that the backend lifecycle surfaces honestly (ready, or
// a truthful error) — it never asserts fake transcription success.

const root = path.resolve(__dirname, '..');
const mainEntry = path.join(root, 'dist', 'main', 'main.js');

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [
      mainEntry,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('renders the SKAZ shell', async () => {
  // The titlebar is a bare drag strip now (no wordmark) — the session rail is
  // the shell's first real landmark.
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
});

test('exposes the secure preload bridge and hides the token', async () => {
  const shape = await page.evaluate(() => {
    const bridge = (window as unknown as { audiohelper?: Record<string, unknown> }).audiohelper;
    return {
      hasBridge: typeof bridge === 'object' && bridge !== null,
      methods: bridge ? Object.keys(bridge).sort() : [],
      // The token/port must never be exposed to the renderer.
      leaks: bridge ? JSON.stringify(bridge).includes('token') : false,
    };
  });
  expect(shape.hasBridge).toBe(true);
  expect(shape.methods).toContain('request');
  expect(shape.methods).toContain('uploadAudio');
  expect(shape.leaks).toBe(false);
});

test('surfaces the backend lifecycle honestly (ready or truthful error)', async () => {
  const pill = page.locator('.status-pill');
  await expect(pill).toBeVisible();
  // The pill renders as a bare coloured dot; the phase is carried by its
  // accessible name and tooltip, not by visible text. Either the backend became
  // ready, or the gate names a truthful error — but the app never claims
  // readiness without a real health check.
  const label = (await pill.getAttribute('aria-label'))?.toLowerCase() ?? '';
  expect(label).toMatch(/backend (ready|error|stopped)|starting backend/);
});
