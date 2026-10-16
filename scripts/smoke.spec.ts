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

test('renders the SKAZ shell once the backend is really ready', async () => {
  // The interface waits for a real /health check; it never claims readiness on its own.
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
    { timeout: 60_000 }).toBe('ready');
  await expect(page.locator('html[data-kb-ui]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: 'Welcome to SKAZ' })).toBeVisible({ timeout: 30_000 });
});

test('exposes the secure preload bridge and hides the token', async () => {
  const shape = await page.evaluate(() => {
    const bridge = (window as unknown as { skaz?: Record<string, unknown> }).skaz;
    return {
      hasBridge: typeof bridge === 'object' && bridge !== null,
      methods: bridge ? Object.keys(bridge).sort() : [],
      // The token/port must never be exposed to the renderer.
      leaks: bridge ? JSON.stringify(bridge).includes('token') : false,
    };
  });
  expect(shape.hasBridge).toBe(true);
  expect(shape.methods).toContain('request');
  expect(shape.methods).toContain('openNative');
  expect(shape.leaks).toBe(false);
});
