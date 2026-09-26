import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeRequest } from '../frontend/src/api/bridge';

const root = path.resolve(__dirname, '..');

// Controlled IPC replay: real Chromium layout/selection, NOT real speech or ASR.
test('vertical time parts preserve reading positions, citations and ordinary copying', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-window-ui-')));
  const app = await electron.launch({ args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0' } });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect.poll(() => page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
    await page.evaluate(() => window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru', 'en'] } }));
    const settings = await page.evaluate(() => window.audiohelper.request({ method: 'GET', path: '/settings' }));
    await app.evaluate(({ ipcMain }, settings) => {
      const session = { id: 'window-fixture', title: 'Window replay', mode: 'legacy', status: 'stopped',
        duration_ms: 1024 * 30_000, created_at: '2026-01-01T00:00:00Z' };
      ipcMain.removeHandler('backend:request');
      ipcMain.handle('backend:request', (_event, req: BridgeRequest) => {
        if (req.path === '/settings') return settings;
        let data: unknown;
        if (req.path === '/storage/layout') data = { enabled: false, revision: 0, pending: false };
        if (req.path === '/sessions') data = { sessions: [session] };
        if (req.path === `/sessions/${session.id}`) {
          if (!req.query?.native_window) throw new Error('Unexpected full session read');
          data = { session, segments: [], notes: null, messages: [{ id: 'm', role: 'assistant',
            content: 'A saved citation', created_at: session.created_at,
            citations: [{ segment_id: 's0', start_ms: 0, end_ms: 1000, text: 'Original 0.' }] }] };
        }
        if (req.path === `/sessions/${session.id}/live`) throw new Error('Unexpected full live read');
        if (req.path === `/sessions/${session.id}/live/events`) {
          const limit = Number(req.query?.limit ?? 128);
          const end = Math.min(1023, req.query?.segment_id ? 63 : req.query?.before !== undefined
            ? Number(req.query.before) - 1 : req.query?.after !== undefined ? Number(req.query.after) + limit : 1023);
          const start = req.query?.after !== undefined ? Number(req.query.after) + 1 : Math.max(0, end - limit + 1);
          const owner = { id: 'turn', connection_id: 'c', speaker_number: 1, start_sample: 0 };
          const events = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => {
            const n = start + i;
            return { ordinal: n, segment_ids: [`s${n}`], originals_available: true,
              originals: [{ id: `o${n}`, connection_id: 'c', segment_id: `s${n}`, speaker_number: 1,
                start_sample: n * 30 * 16000, end_sample: (n + 1) * 30 * 16000, text: `Original ${n}. ` }],
              translations: [{ id: `t${n}`, connection_id: 'c', speaker_number: 1,
                text: `Перевод ${n}: здесь сохранён проверяемый текст для проверки непрерывного чтения. ` }],
              order: [{ id: `o${n}`, translation_status: 'original' }, { id: `t${n}`, translation_status: 'translation' }],
              projection: { owners: { [`o${n}`]: owner }, translations: { [`t${n}`]: `g${n}` }, passthrough: [] } };
          });
          data = { protocol: 1, session_id: session.id, recording_mode: 'translation', sample_rate: 16000,
            saved_samples: 1024 * 30 * 16000, transcription: 'inactive', translation_target_language: 'ru',
            connection: { id: 'c', start_sample: 0, end_sample: 1024 * 30 * 16000, status: 'finished',
              final_sample: 1024 * 30 * 16000, processed_sample: 1024 * 30 * 16000 },
            through: 1023, events, next_before: start, next_after: end, has_older: start > 0, has_newer: end < 1023,
            previous_connection_id: null, next_connection_id: null, tail: null,
            projection: { available: true, tail: null,
              groups: Object.fromEntries(events.map(event => [`g${event.ordinal}`, owner])) } };
        }
        return data ? { ok: true, status: 200, data } : { ok: false, status: 404, detail: 'UI fixture only' };
      });
    }, settings);
    await page.reload();
    await expect(page.locator('[data-native-anchor="t1023"]')).toBeVisible();
    await expect(page.getByText('Копировать оригинал по времени', { exact: true })).toHaveCount(0);
    // Parts are crossed only by a real vertical wheel gesture at the scroll
    // edges — there are no part-navigation buttons in the transcript.
    await expect(page.getByRole('button', { name: 'Предыдущая часть', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Следующая часть', exact: true })).toHaveCount(0);
    const wheelAtEdge = async (edge: 'top' | 'bottom') => {
      await page.locator('.transcript').evaluate((node, where) => {
        node.scrollTop = where === 'top' ? 0 : node.scrollHeight;
      }, edge);
      await page.waitForTimeout(500);
      await page.locator('.transcript').hover();
      await page.mouse.wheel(0, edge === 'top' ? -300 : 300);
    };
    await wheelAtEdge('top');
    await expect(page.locator('[data-native-anchor="t960"]')).toBeAttached();
    await expect(page.locator('[data-source-id="s960"]')).not.toBeVisible();
    expect(await page.locator('[data-source-id]').count()).toBe(60);
    await wheelAtEdge('top');
    await expect(page.locator('[data-native-anchor="t900"]')).toBeAttached();
    await expect(page.locator('[data-native-anchor="t960"]')).toHaveCount(0);
    await wheelAtEdge('bottom');
    await expect(page.locator('[data-native-anchor="t960"]')).toBeAttached();
    await wheelAtEdge('top');
    await expect(page.locator('[data-native-anchor="t900"]')).toBeAttached();
    await page.getByTitle('Original 0.', { exact: true }).click();
    await expect(page.locator('[data-source-id="s0"]')).toBeVisible();
    await expect(page.locator('[data-source-id="s0"]')).toHaveClass(/segment--focused/);
    expect(await page.locator('[data-source-id]').count()).toBe(60);
    expect(await page.evaluate(() => {
      const first = document.querySelector('[data-source-id="s0"]')!;
      const second = document.querySelector('[data-source-id="s1"]')!;
      const range = document.createRange(); range.setStartBefore(first); range.setEndAfter(second);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return selection.toString().trim();
    })).toBe('Original 0. Original 1.');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Original 0. Original 1. ');
    await page.getByRole('button', { name: 'Jump to live' }).click();
    await expect(page.locator('[data-native-anchor="t1023"]')).toBeAttached();
    expect(await page.locator('[data-source-id="s0"]').count()).toBe(0);
    await fs.mkdir(path.join(root, '.runtime/native-parts'), { recursive: true });
    await page.screenshot({ path: path.join(root, '.runtime/native-parts/native-parts-smoke.png') });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
