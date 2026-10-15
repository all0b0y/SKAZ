import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';

// Capabilities the old interface had and the Knowledge Wiki restores (F2), on the REAL built
// Electron app, real preload/IPC policy and real local backend in an isolated profile.
// Nothing here signs in anywhere, downloads a model or touches the microphone.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_F2_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-restored');

let app: ElectronApplication;
let page: Page;
let close: () => Promise<void>;
let profile = '';

async function bridge<T>(method: string, reqPath: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T; detail?: string }> {
  return page.evaluate(({ m, p, b }) => window.skaz.request({ method: m as 'GET', path: p, ...(b === undefined ? {} : { body: b }) }),
    { m: method, p: reqPath, b: body }) as never;
}

/** A changed screen at 1440 in light and dark (system theme, emulated). */
async function shoot(name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function openSettings(section: string) {
  await page.keyboard.press('Meta+Comma');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section }).click();
  return dialog;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  ({ app, close, profile } = await launchIsolatedSmoke('skaz-kb-restored-'));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase), { timeout: 60_000 }).toBe('ready');
  const library = await bridge('POST', '/kb/library', { path: path.join(profile, 'Documents', 'SKAZ') });
  expect(library.ok, library.detail).toBe(true);
  await page.evaluate(() => localStorage.setItem('skaz.kb.prefs', JSON.stringify({ onboardingDone: true, theme: 'system' })));
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  await close?.();
});

test('Settings → Privacy → Activity log reads GET /logs through the real IPC policy and opens the logs folder', async () => {
  const direct = await bridge<{ entries: unknown[]; capacity: number; dropped: number }>('GET', '/logs');
  expect(direct.ok, direct.detail).toBe(true);
  expect(direct.data).toMatchObject({ capacity: expect.any(Number), dropped: 0 });
  // Only the read is allowed: the policy refuses anything else under /logs.
  expect((await bridge('POST', '/logs')).ok).toBe(false);

  const dialog = await openSettings('Privacy');
  await dialog.getByRole('group', { name: 'Activity log' }).getByRole('button', { name: 'Show…' }).click();
  const log = page.getByRole('dialog', { name: 'Activity log' });
  await expect(log).toBeVisible();
  // A fresh profile has run nothing that records activity; the window says so instead of a stub.
  await expect(log.getByText(direct.data.entries.length ? /./ : 'Nothing has run yet.').first()).toBeVisible();
  await shoot('activity-log');
  // The folder button goes through the existing channel; shell.openPath is replaced so nothing opens on this Mac.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedPaths: opened });
    shell.openPath = async (target: string) => { opened.push(target); return ''; };
  });
  await log.getByRole('button', { name: 'Open logs folder' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { openedPaths: string[] }).openedPaths)).toHaveLength(1);
  const opened = await app.evaluate(() => (globalThis as unknown as { openedPaths: string[] }).openedPaths[0]);
  expect(fs.realpathSync(opened).startsWith(profile)).toBe(true);
  await log.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Escape');
});
