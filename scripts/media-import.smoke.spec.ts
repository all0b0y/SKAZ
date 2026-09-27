import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');

// Real Electron/preload/backend/ffprobe. A one-second tone is a media fixture,
// never evidence of real speech recognition; no provider credentials or calls.
test('media dialog resolves an OS-backed dropped File and previews it without a paid job', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-media-')));
  const source = path.join(directory, 'fixture.wav');
  execFileSync(path.join(root, 'backend/.runtime/media-tools/ffmpeg'), [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', source,
  ]);
  const app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      SKAZ_OPTIN_SMOKE_USER_DATA: directory,
      SKAZ_SESSION_FILES_ROOT: path.join(directory, 'files'),
      PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      SKAZ_ALLOW_MODEL_DOWNLOAD: '0', SKAZ_LIVE_FINALITY: '0', SKAZ_LOCAL_SPEECH_GATE: '0',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.skaz.getBackendStatus())).toMatchObject({ phase: 'ready' });
    const onboarding = page.getByRole('dialog', { name: 'Which languages do you speak?' });
    await expect(onboarding).toBeVisible();
    await onboarding.getByRole('button', { name: 'Russian + English', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Import audio', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Import media' })).toBeVisible();
    await expect(page.getByLabel('YouTube link')).toBeVisible();
    // CDP supplies a genuine disk-backed File rather than a synthetic File with no path.
    await page.evaluate(() => {
      const input = document.createElement('input'); input.type = 'file'; input.id = 'fixture-drop';
      document.body.append(input);
    });
    await page.locator('#fixture-drop').setInputFiles(source);
    const resolved = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#fixture-drop')!;
      const file = input.files![0]!;
      const result = window.skaz.droppedMediaFile?.(file);
      const transfer = new DataTransfer(); transfer.items.add(file);
      document.querySelector('.import-dialog__drop')!.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      input.remove();
      return result?.path;
    });
    expect(resolved).toBe(source);
    await expect(page.getByLabel('Session name')).toHaveValue('fixture');
    await expect(page.getByText('1 s', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Transcribe', exact: true })).toBeDisabled();
    await page.getByLabel('YouTube link').fill('https://example.com/not-youtube');
    await expect(page.getByLabel('Session name')).toHaveCount(0);
    await page.getByRole('button', { name: 'Check link' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    const imports = await page.evaluate(() => window.skaz.request<{ imports: unknown[] }>({ method: 'GET', path: '/imports/active' }));
    expect(imports.ok && imports.data.imports).toEqual([]);
    expect((await fs.stat(source)).size).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(root, '.runtime/media-import.png') });
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
