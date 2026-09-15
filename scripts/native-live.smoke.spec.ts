import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('native PCM crosses production preload/main/backend with durable pause/resume and exact playback', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-native-smoke-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts', 'optin-smoke', 'main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory,
      PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
    },
  });
  try {
    const paths = await app.evaluate(({ app }) => ({ user: app.getPath('userData'), session: app.getPath('sessionData') }));
    expect(await fs.realpath(paths.user)).toBe(directory);
    expect(await fs.realpath(paths.session)).toBe(path.join(directory, 'session'));
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect.poll(() => page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('используемые языки');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('Выбрать языки', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Русский', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Английский', exact: true }).check();
    await page.getByLabel('Режим новой записи').selectOption('translation');
    await page.getByLabel('Язык перевода').selectOption('de');
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/used-languages.png') });
    await page.getByRole('button', { name: 'API keys', exact: true }).click();
    await expect(page.getByLabel('Soniox API key')).toHaveAttribute('type', 'password');
    await expect(page.getByRole('checkbox', { name: /Allow cloud processing/ })).not.toBeChecked();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    const settings = await page.evaluate(() => window.audiohelper.request({ method: 'GET', path: '/settings' }));
    expect(settings).toMatchObject({ ok: true, data: { cloud_consent: false, soniox_has_api_key: false,
      used_languages: ['ru', 'en'], native_recording_mode: 'translation', translation_target_language: 'de' } });
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/soniox-settings.png') });
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
    const result = await page.evaluate(async () => {
      const api = window.audiohelper;
      const failures: unknown[] = [];
      const unsubscribe = api.onNativeFailure((failure) => failures.push(failure));
      const created = await api.request<{ id: string }>({ method: 'POST', path: '/sessions', body: { title: 'Native offline smoke' } });
      if (!created.ok) throw new Error('create failed');
      const id = created.data.id;
      const open = await api.openNative(id, 16000);
      if (!open.ok || open.data.transcription !== 'unavailable') throw new Error('offline fixture not isolated');
      const pcm = new ArrayBuffer(3200);
      new DataView(pcm).setInt16(0, -123, true);
      const saved = await api.sendNativeAudio(id, { sequence: 0, startSample: 0 }, pcm);
      const paused = await api.endNative(id, 'pause');
      const repeat = await api.endNative(id, 'pause');
      const resumed = await api.openNative(id, 16000);
      const savedAgain = await api.sendNativeAudio(id, { sequence: 1, startSample: 1600 }, new ArrayBuffer(3200));
      const stopped = await api.endNative(id, 'stop');
      const snapshot = await api.request({ method: 'GET', path: `/sessions/${id}/live` });
      const wav = await api.fetchAudio(id, 0);
      if (!wav.ok) throw new Error(JSON.stringify({ failures, open, saved, paused, resumed, savedAgain, stopped, snapshot, playback: wav }));
      const sample = new DataView(wav.data).getInt16(44, true);
      unsubscribe();
      return { id, open, saved, paused, repeat, resumed, savedAgain, stopped, snapshot, sample,
        exposesSecret: ['token', 'port', 'getHandle'].some((name) => name in api) };
    });
    expect(result.open).toMatchObject({ ok: true, data: { saved_samples: 0, next_sequence: 0, transcription: 'unavailable' } });
    expect(result.saved).toMatchObject({ ok: true, data: { saved_samples: 1600, sequence: 0 } });
    expect(result.paused).toMatchObject({ ok: true, data: { status: 'paused', transcription_complete: false } });
    expect(result.repeat).toEqual(result.paused);
    expect(result.resumed).toMatchObject({ ok: true, data: { saved_samples: 1600, next_sequence: 1 } });
    expect(result.savedAgain).toMatchObject({ ok: true, data: { saved_samples: 3200 } });
    expect(result.stopped).toMatchObject({ ok: true, data: { status: 'stopped', saved_samples: 3200 } });
    expect(result.snapshot).toMatchObject({ ok: true, data: { saved_samples: 3200, transcription: 'inactive',
      used_languages: ['ru', 'en'], recording_mode: 'translation', translation_target_language: 'de' } });
    expect(result.sample).toBe(-123);
    await page.reload();
    // refreshSessions selects the sole restored session on startup.
    await expect(page.getByText('Часть сохранённого аудио не распознана.', { exact: true })).toBeVisible();
    await expect(page.getByText('Soniox: not active', { exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: 'Diagnostic audio', exact: true }).click();
    await expect(page.getByText('Soniox: not active', { exact: true })).toBeVisible();
    await expect(page.getByText('Audio saved through 00:00.200.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Unconfirmed transcription ranges')).toContainText('00:00.000–00:00.100');
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/soniox-native-status.png') });
    const deletion = await page.evaluate(async (id) => ({
      deleted: await window.audiohelper.request({ method: 'DELETE', path: `/sessions/${id}` }),
      absent: await window.audiohelper.request({ method: 'GET', path: `/sessions/${id}` }),
    }), result.id);
    expect(deletion.deleted.ok).toBe(true);
    expect(deletion.absent).toMatchObject({ ok: false, status: 404 });
    expect(result.exposesSecret).toBe(false);
    const local = await page.evaluate(async () => {
      const api = window.audiohelper;
      const preferences = await api.request({ method: 'PUT', path: '/settings', body: {
        native_recording_mode: 'audio_only', translation_target_language: 'de',
      } });
      if (!preferences.ok) throw new Error('preferences failed');
      const created = await api.request<{ id: string }>({ method: 'POST', path: '/sessions', body: { title: 'Audio only' } });
      if (!created.ok) throw new Error('create failed');
      const id = created.data.id;
      const opened = await api.openNative(id, 16000);
      const saved = await api.sendNativeAudio(id, { sequence: 0, startSample: 0 }, new ArrayBuffer(3200));
      const stopped = await api.endNative(id, 'stop');
      const snapshot = await api.request({ method: 'GET', path: `/sessions/${id}/live` });
      return { opened, saved, stopped, snapshot };
    });
    expect(local.opened).toMatchObject({ ok: true, data: { transcription: 'disabled' } });
    expect(local.saved).toMatchObject({ ok: true, data: { saved_samples: 1600 } });
    expect(local.stopped).toMatchObject({ ok: true, data: { status: 'stopped', transcription_complete: false } });
    expect(local.snapshot).toMatchObject({ ok: true, data: {
      recording_mode: 'audio_only', translation_target_language: 'de', saved_samples: 1600, final_tokens: [],
    } });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Diagnostic audio', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Diagnostic audio', exact: true }).click();
    await expect(page.getByText('Audio-only recording — transcription is disabled', { exact: true })).toBeVisible();
    await expect(page.getByText('Transcription finalization incomplete.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Часть сохранённого аудио не распознана.', { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
