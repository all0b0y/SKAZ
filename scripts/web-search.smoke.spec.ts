import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('query-only web approval through real Electron and Codex, no external API', async () => {
  test.setTimeout(120_000);
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-codex-e2e-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts/codex-e2e/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: profile, NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: profile,
      SKAZ_FIXTURE_CODEX: process.env.SKAZ_FIXTURE_CODEX ?? '/Users/all0b0y/.local/bin/codex',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0' },
  });
  try {
    expect(await app.evaluate(({ app: a }) => a.getPath('userData'))).toBe(profile);
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.audiohelper.getBackendStatus()).phase),
      { timeout: 60_000 }).toBe('ready');
    expect(fs.existsSync(path.join(profile, 'data/skaz.sqlite3'))).toBe(true);
    await page.evaluate(async () => {
      const r = await window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } });
      if (!r.ok) throw new Error(r.detail);
    });
    await page.reload();
    await page.getByText('AUTHORED E2E SESSION', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Web Search', exact: true }).click();
    await page.getByLabel('Brave Search API key').fill('authored-fixture-key');
    await page.getByRole('checkbox', { name: 'Allow web search suggestions, approving each request' }).check();
    await page.getByRole('button', { name: 'Save search' }).click();
    await expect(page.getByText('Search settings saved.')).toBeVisible();
    await page.getByLabel('Close', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
    const input = page.locator('.assistant--codex textarea');
    await input.fill('WEB_SEARCH_FIXTURE PRIVATE_CONTEXT_MARKER');
    await input.press('Enter');
    const consent = page.getByRole('region', { name: 'Web search approval' });
    await expect(consent.locator('pre')).toHaveText('approved public query', { timeout: 45_000 });
    const record = path.join(profile, 'data/fixture-search-requests.json');
    expect(fs.existsSync(record)).toBe(false);
    fs.mkdirSync(path.join(root, '.runtime/web-search'), { recursive: true });
    await page.screenshot({ path: path.join(root, '.runtime/web-search/approval.png') });
    await consent.getByRole('button', { name: 'Allow this request' }).click();
    await expect(consent.locator('pre')).toHaveText('changed follow-up query', { timeout: 45_000 });
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual(['approved public query']);
    await consent.getByRole('button', { name: 'Don’t search' }).click();
    await expect(page.locator('.msg--assistant').last()).toContainText('AUTHORED WEB ANSWER', { timeout: 45_000 });
    await expect(page.locator('.msg--assistant').last().getByRole('link', { name: 'Source' }))
      .toHaveAttribute('href', 'https://example.org/source');
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual(['approved public query']);
    const requests = fs.readFileSync(path.join(profile, 'data/fixture-requests.json'), 'utf8');
    expect(requests).toContain('AUTHORED SEARCH EVIDENCE');
    expect(requests).toContain('declined');
  } finally { await app.close(); }
});
