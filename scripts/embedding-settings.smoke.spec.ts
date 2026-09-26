import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeRequest } from '../frontend/src/api/bridge';

const root = path.resolve(__dirname, '..');

// Built-renderer UI fixture, not an embedding API or retrieval-quality test.
test('Embedding card uses its own catalog and preserves the saved selection', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-embedding-ui-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts', 'optin-smoke', 'main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory, AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0' },
  });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
    await page.evaluate(() => window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru', 'en'] } }));
    const settings = await page.evaluate(() => window.audiohelper.request({ method: 'GET', path: '/settings' }));
    await app.evaluate(({ ipcMain }, initial) => {
      if (!initial.ok) throw new Error('Settings failed');
      const data = initial.data as { embedding: { provider: string; model: string }; embedding_budget_usd: number | null };
      ipcMain.removeHandler('backend:request');
      ipcMain.handle('backend:request', (_event, req: BridgeRequest) => {
        if (req.path === '/settings') {
          if (req.method === 'PUT') {
            const patch = req.body as { embedding?: { model?: string }; embedding_budget_usd?: number | null };
            if ("embedding_budget_usd" in patch) data.embedding_budget_usd = patch.embedding_budget_usd ?? null;
            if (patch.embedding) data.embedding = { ...data.embedding, ...patch.embedding };
          }
          return { ok: true, status: 200, data };
        }
        if (req.path.startsWith('/models')) return { ok: true, status: 200, data: { models: [{
          id: 'qwen/qwen3-embedding-8b', name: 'Qwen Embedding (UI fixture)',
          input_modalities: ['text'], output_modalities: ['embeddings'], verified: false,
        }] } };
        if (req.path === '/sessions') return { ok: true, status: 200, data: { sessions: [] } };
        return { ok: false, status: 404, detail: 'UI fixture only' };
      });
    }, settings);
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Embedding', exact: true }).click();
    const option = page.getByRole('option', { name: /Qwen Embedding/ });
    await expect(option).toBeEnabled();
    await expect(page.getByRole('tab', { name: 'OpenRouter' })).toBeVisible();
    await expect(page.getByRole('listbox', { name: 'Model' })).toHaveCount(1);
    await option.click();
    const toggle = page.getByRole('checkbox', { name: 'Limit embedding cost per question' });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await page.getByLabel('Embedding limit, USD').fill('0.01');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Embedding', exact: true }).click();
    await expect(page.getByRole('option', { name: /Qwen Embedding/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Embedding limit, USD')).toHaveValue('0.01');
    await page.screenshot({ path: path.join(root, '.runtime/retrieval-spike/embedding-card.png') });
    await page.getByRole('checkbox', { name: 'Limit embedding cost per question' }).uncheck();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Embedding', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Limit embedding cost per question' })).not.toBeChecked();
    await expect(page.getByLabel('Embedding limit, USD')).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
