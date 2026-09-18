import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
test('transcript-only desktop accepts PCM without archiving and resumes its clock', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-only-smoke-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      PYTHONPATH: path.join(root, 'backend/src'),
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory,
      PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring', AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0' },
  });
  app.process().stdout?.on('data', (data) => console.log(String(data)));
  app.process().stderr?.on('data', (data) => console.log(String(data)));
  try {
    const paths = await app.evaluate(({ app }) => ({ user: app.getPath('userData'), session: app.getPath('sessionData') }));
    expect(paths.user).toBe(directory);
    expect(paths.session).toBe(path.join(directory, 'session'));
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
    const onboarding = page.getByRole('dialog', { name: 'На каких языках вы говорите?' });
    await onboarding.getByRole('button', { name: 'Русский + English', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Продолжить', exact: true }).click();
    const result = await page.evaluate(async () => {
      const api = window.audiohelper;
      const created = await api.request<{ id: string }>({ method: 'POST', path: '/sessions', body: { title: 'Transient smoke' } });
      if (!created.ok) throw new Error('session creation failed');
      const id = created.data.id;
      const opened = await api.openNative(id, 16000);
      for (let i = 0; i < 100; i++) {
        const ack = await api.sendNativeAudio(id, { sequence: i, startSample: i * 1600 }, new ArrayBuffer(3200));
        if (!ack.ok || ack.data.saved_samples !== (i + 1) * 1600) throw new Error('bad receipt');
      }
      const paused = await api.endNative(id, 'pause');
      const resumed = await api.openNative(id, 16000);
      const ended = await api.endNative(id, 'stop');
      const audio = await api.fetchAudio(id, 0);
      return { id, opened, paused, resumed, ended, audioAvailable: audio.ok };
    });
    expect(result.opened).toMatchObject({ ok: true, data: { audio_retained: false } });
    expect(result.resumed).toMatchObject({ ok: true, data: { saved_samples: 160000, next_sequence: 100, audio_retained: false } });
    expect(result.ended).toMatchObject({ ok: true, data: { status: 'stopped' } });
    expect(result.audioAvailable).toBe(false);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Continue recording', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Diagnostic audio', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Режим новой записи').locator('option[value="audio_only"]')).toHaveCount(0);
    await expect(page.getByText('Сохраняются транскрипция и таймкоды. Аудио используется для распознавания и не сохраняется.')).toBeVisible();
    await page.screenshot({ path: '/tmp/transcript-only-settings.png' });
    const files = await fs.readdir(path.join(directory, 'data/audio'), { recursive: true });
    expect(files.filter((name) => name.endsWith('.wav'))).toEqual([]);
  } finally { await app.close(); }
});
