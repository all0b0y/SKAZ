import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Actual renderer → preload → HTTP → Runtime → real Codex → local authored
// Responses peer → tools → durable result. No model-quality or subscription claim.
const root = path.resolve(__dirname, '..');

test('Codex runtime roundtrip, Notes, confirmed edit and reopen', async () => {
  test.setTimeout(180_000);
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-codex-e2e-')));
  const launch = () => electron.launch({
    args: [path.join(root, 'scripts/codex-e2e/main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: profile, NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: profile,
      SKAZ_FIXTURE_CODEX: process.env.SKAZ_FIXTURE_CODEX ?? '/Users/all0b0y/.local/bin/codex',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0',
    },
  });
  let app = await launch();
  try {
    expect(await app.evaluate(({ app: a }) => a.getPath('userData'))).toBe(profile);
    let page = await app.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.audiohelper.getBackendStatus()).phase),
      { timeout: 60_000 }).toBe('ready');
    await page.evaluate(async () => {
      const res = await window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } });
      if (!res.ok) throw new Error(res.detail);
    });
    await page.reload();
    await expect(page.locator('.gate')).toHaveCount(0);
    await page.getByText('AUTHORED E2E SESSION', { exact: true }).first().click();
    const input = page.locator('.assistant--codex textarea');
    await expect(input).toBeEnabled({ timeout: 15_000 });
    await input.fill('Read authored source');
    await input.press('Enter');
    await expect(page.locator('.msg--assistant').first()).toContainText('AUTHORED E2E ANSWER', { timeout: 45_000 });
    const state = await page.evaluate(async () => {
      const r = await window.audiohelper.request({ method: 'GET', path: '/codex/state' });
      if (!r.ok) throw new Error(r.detail);
      return r.data as { tasks: { session_ids: string[]; citations: unknown[] }[] };
    });
    expect(state.tasks[0]!.citations).toHaveLength(1);
    const sid = state.tasks[0]!.session_ids[0]!;
    // This button is the production Notes entry point, not an API-only shortcut.
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await page.getByRole('button', { name: /Create AI notes/ }).first().click();
    await expect(page.locator('.cm-content')).toContainText('AUTHORED E2E ANSWER', { timeout: 45_000 });
    await expect(page.locator('.cm-content')).toContainText('AUTHORED EXTRA SECTION');
    await expect(page.locator('.cm-content')).not.toContainText('SKAZ_NOTE_CONTINUE');
    await expect(page.locator('.cm-content')).not.toContainText('[P1]');
    await input.fill('EDIT_NOTE');
    await input.press('Enter');
    await expect(page.getByTestId('codex-preview')).toBeVisible({ timeout: 45_000 });
    await page.getByRole('button', { name: 'Compare and apply' }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByTestId('codex-preview')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toContainText('AUTHORED EDIT');
    const requests = JSON.parse(fs.readFileSync(path.join(profile, 'data/fixture-requests.json'), 'utf8'));
    expect(requests.length).toBeGreaterThanOrEqual(6);
    for (const r of requests) {
      const tools = r.tools.map((t: { name?: string; type: string }) => t.name ?? t.type);
      for (const forbidden of ['shell', 'shell_command', 'exec_command', 'apply_patch', 'spawn_agent', 'web_search']) {
        expect(tools).not.toContain(forbidden);
      }
      if (JSON.stringify(r.input).includes('exactly ONE note')) {
        expect(tools.filter((name: string) => name.startsWith('skaz_'))).toEqual(['skaz_read_transcript']);
      }
    }
    expect(requests.some((r: { input: unknown }) =>
      JSON.stringify(r.input).includes('exactly ONE note'))).toBe(true);
    await input.fill('PAUSE_FIXTURE');
    await input.press('Enter');
    await expect(page.locator('.codex-task--paused')).toContainText('AUTHORED PARTIAL', { timeout: 45_000 });
    const beforeReopen = fs.readFileSync(path.join(profile, 'data/fixture-requests.json'), 'utf8');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.audiohelper.getBackendStatus()).phase),
      { timeout: 60_000 }).toBe('ready');
    await page.getByText('AUTHORED E2E SESSION', { exact: true }).first().click();
    await expect(page.locator('.assistant--codex')).toContainText('AUTHORED E2E ANSWER');
    const notes = await page.evaluate(async (id) => {
      const r = await window.audiohelper.request({ method: 'GET', path: `/sessions/${id}` });
      if (!r.ok) throw new Error(r.detail);
      return r.data as { notes_list: { content: string }[] };
    }, sid);
    expect(notes.notes_list).toHaveLength(1);
    expect(notes.notes_list[0]!.content).toContain('AUTHORED EDIT');
    await expect(page.locator('.codex-task--paused')).toContainText('AUTHORED PARTIAL');
    // Reopening and polling must not dispatch a model turn.
    expect(fs.readFileSync(path.join(profile, 'data/fixture-requests.json'), 'utf8')).toBe(beforeReopen);
    await page.locator('.codex-task--paused').getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('.msg--assistant').last()).toContainText('AUTHORED CONTINUATION', { timeout: 45_000 });
    await expect(page.locator('.msg--assistant').last()).not.toContainText('AUTHORED PARTIAL');
  } finally {
    await app.close();
  }
});
