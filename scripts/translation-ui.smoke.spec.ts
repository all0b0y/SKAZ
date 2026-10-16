import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NativeEventPage } from '../frontend/src/api/nativeEventPages';
import type { BridgeRequest } from '../frontend/src/api/bridge';

const root = path.resolve(__dirname, '..');

// UI-only IPC fixtures: this verifies the built renderer, NOT real ASR/translation.
test('translation is primary and original is collapsed in the built Electron renderer', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-translation-ui-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts', 'optin-smoke', 'main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      SKAZ_OPTIN_SMOKE_USER_DATA: directory,
      PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      SKAZ_ALLOW_MODEL_DOWNLOAD: '0', SKAZ_LIVE_FINALITY: '0', SKAZ_LOCAL_SPEECH_GATE: '0',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.skaz.getBackendStatus())).toMatchObject({ phase: 'ready' });
    await page.evaluate(() => window.skaz.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru', 'en'] } }));
    const settings = await page.evaluate(() => window.skaz.request({ method: 'GET', path: '/settings' }));
    const original = { id: 'o1', connection_id: 'c1', segment_id: 's1', speaker_number: 1,
      text: 'We will discuss the results tomorrow.', start_sample: 0, end_sample: 16000 };
    const owner = { id: 'o1', connection_id: 'c1', speaker_number: 1, start_sample: 0 };
    const eventPage: NativeEventPage = {
      protocol: 1, session_id: 'translation-fixture', sample_rate: 16000, saved_samples: 16000,
      recording_mode: 'translation', translation_target_language: 'ru', transcription: 'inactive',
      connection: { id: 'c1', start_sample: 0, end_sample: 16000, status: 'finished',
        final_sample: 16000, processed_sample: 16000 },
      through: 0, next_before: 0, next_after: 0, has_older: false, has_newer: false,
      previous_connection_id: null, next_connection_id: null, tail: null,
      events: [{ ordinal: 0, segment_ids: ['s1'], originals_available: true, originals: [original],
        translations: [{ id: 't1', connection_id: 'c1', speaker_number: 1, text: 'Мы обсудим результаты завтра.' }],
        order: [{ id: 'o1', translation_status: 'original' }, { id: 't1', translation_status: 'translation' }],
        projection: { owners: { o1: owner }, translations: { t1: 'g1' }, passthrough: [] },
      }],
      projection: { available: true, groups: { g1: owner }, tail_groups: {}, tail: null },
    };
    await app.evaluate(({ ipcMain }, fixture) => {
      // Every session route the renderer asks for and the fixture does not know.
      // When the transcript endpoint moves again, the test names the new path
      // instead of failing later as "translation not found".
      const unhandled: string[] = [];
      (globalThis as { unhandledFixturePaths?: string[] }).unhandledFixturePaths = unhandled;
      const session = { id: fixture.eventPage.session_id, title: 'Translation UI fixture', mode: 'legacy',
        status: 'stopped', duration_ms: 1000, created_at: '2026-01-01T00:00:00Z' };
      ipcMain.removeHandler('backend:request');
      ipcMain.handle('backend:request', (_event, req: BridgeRequest) => {
        if (req.path === '/settings') return fixture.settings;
        const data = req.path === '/sessions' ? { sessions: [session] }
          : req.path === `/sessions/${session.id}` ? { session, segments: [{ id: 's1', start_ms: 0, end_ms: 1000,
            text: 'We will discuss the results tomorrow.' }], messages: [], notes: null }
          : req.path === `/sessions/${session.id}/live/events` ? {
            ...fixture.eventPage,
            events: req.query?.after !== undefined && Number(req.query.after) >= fixture.eventPage.through
              ? [] : fixture.eventPage.events,
          } : undefined;
        if (!data && req.path.startsWith(`/sessions/${session.id}`)) unhandled.push(`${req.method} ${req.path}`);
        return data ? { ok: true, status: 200, data } : { ok: false, status: 404, detail: 'UI fixture only' };
      });
    }, { settings, eventPage });
    const unhandled = () => app.evaluate(() => (globalThis as { unhandledFixturePaths?: string[] }).unhandledFixturePaths ?? []);
    await page.reload();
    const list = page.getByRole('list', { name: 'Transcript' });
    await expect(list).toBeVisible({ timeout: 15_000 }).catch(async (error: unknown) => {
        throw new Error(`${String(error)}\nunanswered fixture routes: ${JSON.stringify(await unhandled())}`);
      });
    await expect(list.getByText('Мы обсудим результаты завтра.', { exact: true })).toBeVisible();
    await expect(list.getByText(original.text, { exact: true })).not.toBeVisible();
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/translation-primary.png') });
    await list.getByText('Show original', { exact: true }).click();
    await expect(list.getByText(original.text, { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/translation-original.png') });
    await page.reload();
    await expect(list.getByText('Мы обсудим результаты завтра.', { exact: true })).toBeVisible();
    await expect(list.getByText(original.text, { exact: true })).not.toBeVisible();
    await expect(list.getByText('Show original', { exact: true })).toBeVisible();
    // The transcript was read only through routes the fixture answers.
    expect((await unhandled()).filter((route) => route.includes('/live')), 'transcript routes the fixture does not serve').toEqual([]);
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
