import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NativeSnapshot } from '../frontend/src/api/nativeLive';
import type { BridgeRequest } from '../frontend/src/api/bridge';

const root = path.resolve(__dirname, '..');

// UI-only IPC fixtures: this verifies the built renderer, NOT real ASR/translation.
test('translation is primary and original is collapsed in the built Electron renderer', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-translation-ui-')));
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
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
    const settings = await page.evaluate(() => window.audiohelper.request({ method: 'GET', path: '/settings' }));
    const original = { id: 'o1', connection_id: 'c1', segment_id: 's1', speaker_number: 1,
      text: 'We will discuss the results tomorrow.', start_sample: 0, end_sample: 16000 };
    const snapshot: NativeSnapshot = {
      session_id: 'translation-fixture', sample_rate: 16000, saved_samples: 16000, next_sequence: 1,
      recording_mode: 'translation', transcription: 'inactive', gaps: [], final_tokens: [original],
      connections: [], live_translation_projection: {
        original_tokens: [original],
        translation_tokens: [{ id: 't1', connection_id: 'c1', speaker_number: 1, text: 'Мы обсудим результаты завтра.' }],
        monologues: [{ id: 'o1', connection_id: 'c1', speaker_number: 1, original_token_ids: ['o1'],
          translation_token_ids: ['t1'], passthrough_token_ids: [], display_token_ids: ['t1'] }],
        unassigned_translation_token_ids: [], order_unavailable_connection_ids: [],
      },
    };
    await app.evaluate(({ ipcMain }, fixture) => {
      const session = { id: fixture.snapshot.session_id, title: 'Translation UI fixture', mode: 'legacy',
        status: 'stopped', duration_ms: 1000, created_at: '2026-01-01T00:00:00Z' };
      ipcMain.removeHandler('backend:request');
      ipcMain.handle('backend:request', (_event, req: BridgeRequest) => {
        if (req.path === '/settings') return fixture.settings;
        const data = req.path === '/sessions' ? { sessions: [session] }
          : req.path === `/sessions/${session.id}` ? { session, segments: [{ id: 's1', start_ms: 0, end_ms: 1000,
            text: 'We will discuss the results tomorrow.' }], messages: [], notes: null }
          : req.path === `/sessions/${session.id}/live` ? fixture.snapshot : undefined;
        return data ? { ok: true, status: 200, data } : { ok: false, status: 404, detail: 'UI fixture only' };
      });
    }, { settings, snapshot });
    await page.reload();
    const list = page.getByRole('list', { name: 'Транскрипция' });
    await expect(list.getByText('Мы обсудим результаты завтра.', { exact: true })).toBeVisible();
    await expect(list.getByText(original.text, { exact: true })).not.toBeVisible();
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/translation-primary.png') });
    await list.getByText('Показать оригинал', { exact: true }).click();
    await expect(list.getByText(original.text, { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(root, '.runtime/soniox-migration/translation-original.png') });
    await page.reload();
    await expect(page.getByRole('list', { name: 'Транскрипция' }).getByText(original.text, { exact: true })).not.toBeVisible();
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
