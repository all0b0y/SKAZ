import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
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
/** An isolated model cache (SKAZ_MODEL_CACHE): deletion must never reach this Mac's Hugging Face cache. */
const modelCache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-model-cache-')));
const SMALL = path.join(modelCache, 'models--Systran--faster-whisper-small');
const BASE = path.join(modelCache, 'models--Systran--faster-whisper-base');

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
  // Placeholder files where the chosen Whisper model (small) and another one would be: not a model.
  for (const repo of [SMALL, BASE]) {
    fs.mkdirSync(path.join(repo, 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'blobs', 'placeholder.bin'), Buffer.alloc(4096));
  }
  ({ app, close, profile } = await launchIsolatedSmoke('skaz-kb-restored-', { env: { SKAZ_MODEL_CACHE: modelCache } }));
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
  fs.rmSync(modelCache, { recursive: true, force: true });
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

test('a denied microphone offers "Open System Settings", which opens the fixed macOS privacy pane', async () => {
  test.skip(process.platform !== 'darwin', 'The panes exist only in macOS System Settings; elsewhere the button is not offered.');
  // The capture boundary refuses like a denied permission prompt; no microphone is touched.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: async () => [],
      getUserMedia: async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); },
    } });
  });
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedUrls: opened });
    shell.openExternal = async (url: string) => { opened.push(url); };
  });
  await page.getByTestId('titlebar').getByRole('button', { name: 'Record', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Recording didn’t start' });
  await expect(popover).toContainText('Microphone access was denied.');
  await shoot('mic-denied');
  await popover.getByRole('button', { name: 'Open System Settings' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls))
    .toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
  // The renderer can only name a pane: a URL or an unknown pane opens nothing.
  const refused = await page.evaluate(async () => {
    const open = (window.skaz as unknown as { openSystemAudioSettings: (pane: string) => Promise<boolean> }).openSystemAudioSettings;
    return [await open('https://example.com'), await open('camera')];
  });
  expect(refused).toEqual([false, false]);
  expect(await app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls)).toHaveLength(1);
  await popover.getByRole('button', { name: 'OK' }).click();
});

test('Settings → Recording & speech deletes the downloaded speech model after a confirmation, and only that model', async () => {
  const dialog = await openSettings('Recording & speech');
  const model = dialog.getByRole('group', { name: 'Speech model on this computer' });
  // The real readiness check sees the files in the isolated cache; the size shown is the model's download size.
  await expect(model.getByText('Whisper small · about 484 MB')).toBeVisible({ timeout: 15_000 });
  await model.getByRole('button', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete the speech model?' });
  await expect(confirm).toContainText('Whisper small (about 484 MB)');
  await shoot('delete-speech-model');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(fs.existsSync(SMALL)).toBe(true);
  await model.getByRole('button', { name: 'Delete…' }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(model.getByRole('status')).toHaveText('Deleted · 4 KB freed');
  await expect(model.getByText('Not downloaded')).toBeVisible();
  expect(fs.existsSync(SMALL)).toBe(false);
  expect(fs.existsSync(path.join(BASE, 'blobs', 'placeholder.bin'))).toBe(true);
  await shoot('speech-model-deleted');

  // Codex: no sign-in in this fresh profile, so no Sign out — the button appears only when signed in.
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Accounts & keys' }).click();
  const codex = dialog.getByRole('group', { name: 'Codex' });
  await expect(codex.locator('.kb-status')).toBeVisible({ timeout: 30_000 });
  await expect(codex.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});
