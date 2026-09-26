import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeRequest } from '../frontend/src/api/bridge';

const root = path.resolve(__dirname, '..');

// Built UI + production preload. IPC fixtures, NOT a live model/retrieval evaluation.
test('Ask library scopes and cross-session source navigation', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-ask-embedding-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts', 'optin-smoke', 'main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory, AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0' },
  });
  try {
    // The real profile must never be touched: prove the relocation before any write.
    expect(await fs.realpath(await app.evaluate(({ app: a }) => a.getPath('userData')))).toBe(directory);
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
    await page.evaluate(() => window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru', 'en'] } }));
    const settings = await page.evaluate(() => window.audiohelper.request({ method: 'GET', path: '/settings' }));
    await app.evaluate(({ ipcMain }, initial) => {
      if (!initial.ok) throw new Error('Settings failed');
      const data = initial.data as { embedding: { provider: string; model: string } };
      data.embedding = { provider: 'openrouter', model: 'qwen/qwen3-embedding-8b' };
      const session = { id: 'embedding-fixture', title: 'Ask embedding fixture', status: 'stopped',
        duration_ms: 1000, created_at: '2026-01-01T00:00:00Z', mode: 'legacy' };
      const other = { ...session, id: 'source-fixture', title: 'Source recording' };
      const citation = { session_id: other.id, session_title: other.title, segment_id: 's1', text: 'Энтропия — мера неопределённости.', start_ms: 0, end_ms: 1000 };
      ipcMain.removeHandler('backend:request');
      ipcMain.handle('backend:request', (_event, req: BridgeRequest) => {
        if (req.path === '/settings') return { ok: true, status: 200, data };
        if (req.path === '/storage/layout') return { ok: true, status: 200,
          data: { enabled: false, revision: 0, pending: null, data: { version: 1, groups: [], membership: {} } } };
        if (req.path === '/sessions') return { ok: true, status: 200, data: { sessions: [session, other] } };
        if (req.path === `/sessions/${session.id}`) return { ok: true, status: 200,
          data: { session, segments: [{ id: 's1', ...citation }], messages: [], notes: null } };
        if (req.path === `/sessions/${other.id}`) return { ok: true, status: 200,
          data: { session: other, segments: [{ id: "s1", ...citation }], messages: [], notes: null } };
        if (req.path === `/sessions/${session.id}/ask`) {
          const body = req.body as { question: string; embedding_budget_usd?: number; search_scope: string; group_session_ids?: string[] };
          if (!["group", "all"].includes(body.search_scope)) throw new Error("Wrong library scope");
          if (body.search_scope === "group" && body.group_session_ids?.length !== 2) throw new Error("Missing local group snapshot");
          if (body.embedding_budget_usd !== undefined) throw new Error('Budget belongs to settings');
          return { ok: true, status: 200, data: { answer: 'Энтропия — мера неопределённости [P1].',
            citations: [citation], model: 'fixture', context: { scope: 'search', start_ms: 0, end_ms: 1000 } } };
        }
        return { ok: false, status: 404, detail: 'UI fixture only' };
      });
    }, settings);
    await page.evaluate(() => localStorage.setItem('audiohelper.session-groups.v1', JSON.stringify({
      version: 1, groups: [{ id: 'g', name: 'Group', tag: '' }],
      membership: { 'embedding-fixture': 'g', 'source-fixture': 'g' },
    })));
    await page.reload();
    const input = page.getByRole('textbox', { name: 'Question' });
    await expect(page.getByLabel('Embedding budget per question, USD')).toHaveCount(0);
    await page.getByRole('button', { name: 'Search · Session' }).click();
    await expect(page.getByRole('button', { name: 'Session', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '5m', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    await input.fill('Как измеряли неопределённость?');
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.locator('.msg--assistant')).toContainText('Энтропия');
    await expect(page.locator('.msg--user')).toHaveCount(1);
    await expect(input).toHaveValue('');
    await expect(page.locator('.msg__cites button')).toContainText('Source recording');
    await page.getByRole('button', { name: 'Search · Group' }).click();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await input.fill('Есть другие определения?');
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.locator('.msg--assistant')).toHaveCount(2);
    await page.getByRole('button', { name: 'Search · All' }).click();
    await page.screenshot({ animations: 'disabled', path: path.join(root, '.runtime/retrieval-spike/ask-embedding.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ animations: 'disabled', path: path.join(root, '.runtime/retrieval-spike/ask-embedding-dark.png') });
    await page.keyboard.press('Escape');
    await page.locator('.msg__cites button').first().click();
    await expect(page.getByRole('button', { name: 'Search · Session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Source recording Saved' })).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.segment--focused')).toContainText('Энтропия');
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
