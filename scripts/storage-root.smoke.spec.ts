import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('explicit Markdown root: picker, confirmation, readback, disk and restart', async () => {
  test.setTimeout(120_000);
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-root-')));
  const chosen = path.join(directory, 'chosen');
  await fs.mkdir(chosen);
  await fs.writeFile(path.join(chosen, 'personal.txt'), 'external fixture');
  const launch = () => electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      SKAZ_OPTIN_SMOKE_USER_DATA: directory, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      SKAZ_ALLOW_MODEL_DOWNLOAD: '0' },
  });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase)).toBe('ready');
    // Set only isolated onboarding preferences; no credentials or cloud consent.
    await page.evaluate(async () => {
      const response = await window.skaz.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } });
      if (!response.ok) throw new Error('Fixture onboarding failed');
    });
    await page.reload();
    await page.getByRole('button', { name: 'New session' }).click();
    const sessions = await page.evaluate(async () => window.skaz.request<{ sessions: { id: string }[] }>({ method: 'GET', path: '/sessions' }));
    if (!sessions.ok) throw new Error('Session read failed');
    const sid = sessions.data.sessions[0]!.id;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByText('Markdown projection is off.')).toBeVisible();
    await expect(page.getByText(path.join(directory, 'Documents/SKAZ'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Use Documents/SKAZ' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await fs.readdir(path.join(directory, 'Documents')))).toEqual([]);
    // Only the OS dialog is a fixture. Actual renderer/preload/main/backend run.
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async (_owner, options) => {
        if (!options?.properties?.includes('openDirectory')) throw new Error('Expected folder chooser');
        return { canceled: false, filePaths: [selected] };
      };
    }, chosen);
    await page.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(page.getByText(chosen, { exact: true })).toBeVisible();
    const before = await page.evaluate(() => window.skaz.request<{ root: string | null }>({ method: 'GET', path: '/storage/root' }));
    expect(before.ok && before.data.root).toBeNull();
    await page.getByRole('button', { name: 'Confirm Markdown root' }).click();
    await expect(page.getByText('Markdown root saved.')).toBeVisible();
    expect(await fs.readdir(chosen)).toEqual(['personal.txt']);
    await page.setViewportSize({ width: 1280, height: 820 });
    const shots = path.join(root, '.runtime/storage-root');
    await fs.mkdir(shots, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await page.waitForTimeout(400); // Wait for the existing colour transition, not backend readiness.
      await page.screenshot({ path: path.join(shots, `${theme}.png`), animations: 'disabled' });
      expect(await page.locator('.settings-content').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    // The per-session "retry file save" panel was removed from the UI, so this
    // smoke no longer forces a session projection; it covers the root choice,
    // its confirmation, persistence and the untouched foreign file.
    void sid;
    await app.close(); app = await launch(); page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByText(chosen, { exact: true })).toBeVisible();
    // The root locks only once Markdown has been written into it
    // (session_files.change_locked); nothing is projected here, so it stays open.
    const persisted = await page.evaluate(() => window.skaz.request<{ root: string; change_locked: boolean }>({ method: 'GET', path: '/storage/root' }));
    expect(persisted.ok && persisted.data).toMatchObject({ root: chosen, change_locked: false });
    await expect(page.getByRole('button', { name: 'Choose folder…' })).toBeEnabled();
    expect(await fs.readFile(path.join(chosen, 'personal.txt'), 'utf8')).toBe('external fixture');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
