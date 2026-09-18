import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('native PCM crosses production preload/main/backend with durable pause/resume and no archived audio', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-native-smoke-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts', 'optin-smoke', 'main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory,
      AUDIOHELPER_SESSION_FILES_ROOT: path.join(directory, 'session-files'),
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
    const onboarding = page.getByRole('dialog', { name: 'На каких языках вы говорите?' });
    await expect(onboarding).toBeVisible();
    await onboarding.getByRole('button', { name: 'Русский + English', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await expect(onboarding).not.toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('summary[aria-labelledby="used-languages-label used-languages-selection"]').click();
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
    expect(settings).toMatchObject({ ok: true, data: { cloud_consent: false, provider_has_api_key: { soniox: false },
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
      // Transcript-only policy: captured PCM is recognised, never archived, so
      // playback must refuse honestly instead of returning bytes.
      const wav = await api.fetchAudio(id, 0);
      unsubscribe();
      return { id, open, saved, paused, repeat, resumed, savedAgain, stopped, snapshot,
        playback: { ok: wav.ok, status: wav.ok ? 200 : wav.status },
        exposesSecret: ['token', 'port', 'getHandle'].some((name) => name in api) };
    });
    expect(result.open).toMatchObject({ ok: true, data: { saved_samples: 0, next_sequence: 0, transcription: 'unavailable', audio_retained: false } });
    expect(result.saved).toMatchObject({ ok: true, data: { saved_samples: 1600, sequence: 0 } });
    expect(result.paused).toMatchObject({ ok: true, data: { status: 'paused', transcription_complete: false } });
    expect(result.repeat).toEqual(result.paused);
    expect(result.resumed).toMatchObject({ ok: true, data: { saved_samples: 1600, next_sequence: 1 } });
    expect(result.savedAgain).toMatchObject({ ok: true, data: { saved_samples: 3200 } });
    expect(result.stopped).toMatchObject({ ok: true, data: { status: 'stopped', saved_samples: 3200 } });
    expect(result.snapshot).toMatchObject({ ok: true, data: { saved_samples: 3200, transcription: 'inactive',
      used_languages: ['ru', 'en'], recording_mode: 'translation', translation_target_language: 'de' } });
    expect(result.playback).toEqual({ ok: false, status: 404 });
    const sessionDirectory = path.join(directory, 'session-files', 'Ungrouped', result.id);
    const transcriptPath = path.join(sessionDirectory, 'Transcript.md');
    const projected = await fs.readFile(transcriptPath, 'utf8');
    expect(projected).toContain('No stable transcript');
    await fs.writeFile(transcriptPath, 'External Markdown edit; preserve me', 'utf8');
    await page.reload();
    // refreshSessions selects the sole restored session on startup.
    await expect(page.getByRole('button', { name: 'Continue recording', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record', exact: true })).not.toBeVisible();
    const continued = await page.evaluate(async (id) => {
      const api = window.audiohelper;
      const opened = await api.openNative(id, 16000);
      const saved = await api.sendNativeAudio(id, { sequence: 2, startSample: 3200 }, new ArrayBuffer(3200));
      const ended = await api.endNative(id, 'stop');
      // The sample clock keeps advancing across a restart even though nothing
      // was archived: continuity comes from the recording row, not from audio.
      const original = await api.fetchAudio(id, 0);
      return { opened, saved, ended, playback: { ok: original.ok, status: original.ok ? 200 : original.status } };
    }, result.id);
    expect(continued).toMatchObject({
      opened: { ok: true, data: { saved_samples: 3200, next_sequence: 2, audio_retained: false } },
      saved: { ok: true, data: { saved_samples: 4800 } },
      ended: { ok: true, data: { saved_samples: 4800, status: 'stopped' } },
      playback: { ok: false, status: 404 },
    });
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe('External Markdown edit; preserve me');
    const conflicts = (await fs.readdir(sessionDirectory)).filter((name) => name.startsWith('Transcript.conflict-'));
    expect(conflicts).toHaveLength(1);
    expect(await fs.readFile(path.join(sessionDirectory, conflicts[0]), 'utf8')).toBe(projected);
    await page.reload();
    const filesPanel = page.getByRole('region', { name: 'Файлы сессии' });
    await expect(filesPanel).toBeVisible();
    await expect(filesPanel.getByRole('alert')).toContainText('Есть внешние правки');
    await filesPanel.getByText('Подробнее о Markdown').click();
    await expect(filesPanel.getByRole('list')).toContainText(conflicts[0]);
    // A DB-only GET cannot discover this new file: the actual UI POST must run.
    const recoveryName = `Transcript.recovery-${'c'.repeat(32)}.md`;
    await fs.writeFile(path.join(sessionDirectory, recoveryName), 'Unknown recovery; keep me', 'utf8');
    await filesPanel.getByRole('button', { name: 'Повторить сохранение файлов' }).click();
    await expect(filesPanel.getByRole('list')).toContainText(recoveryName);
    await expect(filesPanel.getByRole('button', { name: 'Повторить сохранение файлов' })).toBeEnabled();
    await expect(filesPanel.getByRole('alert')).toContainText('Есть внешние правки');
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe('External Markdown edit; preserve me');
    expect(await fs.readFile(path.join(sessionDirectory, recoveryName), 'utf8')).toBe('Unknown recovery; keep me');
    expect((await fs.readdir(sessionDirectory)).filter((name) => name.startsWith('Transcript.conflict-'))).toEqual(conflicts);
    const statusAfterRetry = await page.evaluate((id) => window.audiohelper.request({
      method: 'GET', path: `/sessions/${id}/files`,
    }), result.id);
    expect(statusAfterRetry).toMatchObject({ ok: true, data: { state: 'conflict' } });
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await expect(filesPanel.getByRole('alert')).toContainText('Есть внешние правки');
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/files-conflict-notes.png') });
    await filesPanel.getByRole('listitem').last().scrollIntoViewIfNeeded();
    expect(await filesPanel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    const panelBounds = await filesPanel.boundingBox();
    const recordBounds = await page.getByRole('button', { name: 'Continue recording', exact: true }).boundingBox();
    expect(panelBounds).not.toBeNull();
    expect(recordBounds).not.toBeNull();
    expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(recordBounds!.y);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/files-conflict-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
    // Transcript-only capture: gaps are disclosed in the transcript itself, and
    // the diagnostic audio panel is gone because nothing was archived to play.
    await expect(page.getByText('В транскрипции есть пропуски.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Diagnostic audio', exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/soniox-native-status.png') });
    await page.getByRole('button', { name: 'Actions for Native offline smoke' }).click();
    await page.getByRole('menuitem', { name: 'Delete session…' }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete session?' });
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(deleteDialog.getByRole('alert')).toContainText('Session was not deleted: Markdown files need attention.');
    await expect(page.locator('.session__name')).toHaveText('Native offline smoke');
    const retained = await page.evaluate(async (id) => {
      const audio = await window.audiohelper.fetchAudio(id, 0);
      return { session: await window.audiohelper.request({ method: 'GET', path: `/sessions/${id}` }),
        playback: { ok: audio.ok, status: audio.ok ? 200 : audio.status } };
    }, result.id);
    expect(retained.session.ok).toBe(true);
    expect(retained.playback).toEqual({ ok: false, status: 404 });
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe('External Markdown edit; preserve me');
    expect(await fs.readFile(path.join(sessionDirectory, recoveryName), 'utf8')).toBe('Unknown recovery; keep me');
    await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (!await filesPanel.getByRole('button', { name: 'Разрешить конфликт файлов' }).isVisible()) {
      await filesPanel.getByText('Подробнее о Markdown').click();
    }
    await filesPanel.getByRole('button', { name: 'Разрешить конфликт файлов' }).click();
    const confirmation = filesPanel.getByRole('group', { name: 'Сохранить все текущие версии отдельно?' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Отмена' }).scrollIntoViewIfNeeded();
    expect(await filesPanel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/files-preserve-confirm.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(300); // Let the real theme colour transitions finish before capture.
    await expect(confirmation.getByRole('button', { name: 'Отмена' })).toBeEnabled();
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/files-preserve-confirm-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await confirmation.getByRole('button', { name: 'Сохранить версии отдельно и восстановить Markdown' }).click();
    await expect(filesPanel.getByText('Последнее сохранение Markdown выполнено.')).toBeVisible();
    const regenerated = await page.evaluate((id) => window.audiohelper.request<{ state: string; preserved_directories: string[] }>({
      method: 'GET', path: `/sessions/${id}/files`,
    }), result.id);
    expect(regenerated).toMatchObject({ ok: true, data: { state: 'ready' } });
    if (!regenerated.ok) throw new Error('Preservation failed');
    expect(regenerated.data.preserved_directories).toHaveLength(1);
    const preserved = path.join(directory, 'session-files', regenerated.data.preserved_directories[0]);
    await expect(filesPanel.getByRole('list', { name: 'Сохранённые папки' })).toContainText(regenerated.data.preserved_directories[0]);
    await page.getByRole('button', { name: 'Actions for Native offline smoke' }).click();
    await page.getByRole('menuitem', { name: 'Delete session…' }).click();
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(deleteDialog).not.toBeVisible();
    await expect(page.locator('.session__name')).toHaveCount(0);
    const absent = await page.evaluate((id) => window.audiohelper.request({
      method: 'GET', path: `/sessions/${id}`,
    }), result.id);
    expect(absent).toMatchObject({ ok: false, status: 404 });
    await expect(fs.stat(sessionDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(preserved, 'Transcript.md'), 'utf8')).toBe('External Markdown edit; preserve me');
    expect(await fs.readFile(path.join(preserved, recoveryName), 'utf8')).toBe('Unknown recovery; keep me');
    expect(await fs.readFile(path.join(preserved, conflicts[0]), 'utf8')).toBe(projected);
    expect(result.exposesSecret).toBe(false);
    // Audio-only capture is unreachable while retention is off: Settings does not
    // offer it, and a forced API attempt is downgraded to a transcription
    // recording rather than opening one that would archive nothing.
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
      const stopped = await api.endNative(id, 'stop');
      const snapshot = await api.request({ method: 'GET', path: `/sessions/${id}/live` });
      return { preferences, opened, stopped, snapshot };
    });
    expect(local.opened).toMatchObject({ ok: true, data: { audio_retained: false } });
    expect(local.opened).not.toMatchObject({ data: { transcription: 'disabled' } });
    expect(local.stopped).toMatchObject({ ok: true, data: { status: 'stopped' } });
    expect(local.snapshot).toMatchObject({ ok: true, data: {
      recording_mode: 'transcription', audio_retained: false,
    } });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Diagnostic audio', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Режим новой записи').locator('option[value="audio_only"]')).toHaveCount(0);
    await expect(page.getByText('Сохраняются транскрипция и таймкоды. Аудио используется для распознавания и не сохраняется.')).toBeVisible();
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
