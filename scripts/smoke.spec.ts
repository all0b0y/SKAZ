import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchIsolatedSmoke } from './isolatedSmoke';
import type {} from '../frontend/src/api/bridge';

// Real built shell, isolated profile and backend; no microphone or provider calls.
let app: ElectronApplication;
let page: Page;
let close: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  ({ app, close } = await launchIsolatedSmoke('skaz-shell-smoke-'));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await close?.();
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

test('API keys explains transient audio in the real built window', async ({}, testInfo) => {
  await expect.poll(() => page.evaluate(async () => (await window.audiohelper.getBackendStatus()).phase),
    { timeout: 60_000 }).toBe('ready');
  await page.getByRole('button', { name: 'Russian + English', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'API keys', exact: true }).click();
  await expect(page.getByText('Live transcription. Audio is used for recognition and is not stored.')).toBeVisible();
  await expect(page.getByText(/Recording requires a Soniox key and cloud consent/)).toBeVisible();
  await expect(page.getByText(/Disabling this stops live transcription and recording/)).toBeVisible();
  await expect(page.getByText(/Audio is saved locally|Recording remains local|not local audio recording/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('audio-storage-copy.png') });
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
