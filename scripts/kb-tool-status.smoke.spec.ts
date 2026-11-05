import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// Real renderer/CSS on the established browser fake seam. This checks how saved lifecycle facts
// render, not model quality or a real provider. Backend persistence/event handling has API tests.
const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime', 'shots', 'kb-tool-status');
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({}, info) => {
  info.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  server = await createServer({
    configFile: false, root: path.join(root, 'frontend'), plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'frontend/src') } },
    server: { port: 0, host: '127.0.0.1' }, logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer!.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  browser = await chromium.launch();
  page = await browser.newPage({ deviceScaleFactor: 2 });
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));
});
test.afterAll(async () => { await browser?.close(); await server?.close(); });

async function seed() {
  await page.evaluate(() => {
    type Harness = {
      world: { chats: Array<{ id: string; title: string; engine: string; messages: unknown[]; cursor: number }> };
      services: { chats: { getState(): { open(id: string): void } } };
    };
    const fake = (window as unknown as { __kbFake: Harness }).__kbFake;
    const chat = fake.world.chats.find((c) => c.id === 'c1')!;
    const at = new Date(Date.now() - 60_000).toISOString();
    chat.title = 'Tool lifecycle acceptance';
    chat.engine = 'codex';
    chat.messages = [{
      id: 'lifecycle-answer', seq: 2, role: 'assistant', created_at: at, engine: 'codex', model: null,
      state: 'done', failure: null, saved_page_id: null, input: null,
      parts: [
        { type: 'tool', name: 'skaz_search', label: 'Searched the library', call_id: 'ok', status: 'done', started_at: at, duration_ms: 1_250 },
        { type: 'tool', name: 'skaz_read_page', label: 'Read an unavailable page', call_id: 'error', status: 'error', started_at: at, duration_ms: 450 },
        { type: 'tool', name: 'skaz_wiki_index', label: 'Legacy call without a stored outcome' },
        { type: 'tool', name: 'skaz_read_material', label: 'Read material', call_id: 'stopped', status: 'stopped', started_at: at, duration_ms: 750 },
        { type: 'tool', name: 'skaz_web_search', label: 'Searched the web', call_id: 'web', status: 'done', started_at: at, duration_ms: 900 },
        { type: 'web_search', id: 'lifecycle-web', engine: 'codex', searcher: 'codex', query: 'Example source',
          allowed_domains: [], blocked_domains: [], status: 'allowed', execution: 'done',
          started_at: at, duration_ms: 900, auto: false, reason: null,
          links: [{ title: 'Example source', site: 'example.com', url: 'https://example.com/source' }] },
        { type: 'text', text: 'This text is not evidence that any tool succeeded.' },
      ],
    }];
    chat.cursor = 2;
    fake.services.chats.getState().open('c1');
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const [width, level] of [[1440, 'full'], [1024, 'calm'], [820, 'off']] as const) {
    test(`saved tool facts — ${theme} ${width} ${level}`, async () => {
      const firstError = errors.length;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
      await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
      await seed();
      await page.evaluate((motion) => { document.documentElement.dataset.motion = motion; }, level);
      const answer = page.getByRole('article', { name: 'Answer' });
      const trail = answer.locator('.kb-thought');
      await expect(trail).toHaveAttribute('data-level', level);
      const summary = trail.getByRole('button', { name: '5 tool calls · 1 failed' });
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await summary.click();
      const chips = trail.getByRole('list', { name: 'Tool calls' }).getByRole('listitem');
      await expect(chips).toHaveCount(4); // web details stay in their own card, but the count includes it
      expect(await chips.evaluateAll((els) => els.map((el) => el.getAttribute('data-state'))))
        .toEqual(['done', 'error', 'unknown', 'stopped']);
      await expect(chips.nth(0).locator('.kb-call__time')).toHaveText('1.2 s');
      await expect(chips.nth(1)).toContainText('failed');
      await expect(chips.nth(1).locator('.kb-call__time')).toHaveCount(0);
      await expect(chips.nth(2)).toContainText('result unknown');
      await expect(chips.nth(2).locator('.kb-call__time')).toHaveCount(0);
      await expect(chips.nth(3).locator('.kb-call__time')).toHaveText('0.7 s');
      await expect(trail.getByLabel('Done')).toHaveCount(1);
      await expect(answer.getByRole('button', { name: /Searched the web · Example source · 1 link/ })).toBeVisible();
      expect(await chips.evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length)).toBe(0);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(shots, `${theme}-${width}-${level}.png`), animations: 'disabled' });
      await summary.click();
      await expect(trail.getByRole('list', { name: 'Tool calls' })).toHaveCount(0);
      await summary.click();
      await expect(trail.locator('.kb-call__time').first()).toHaveText('1.2 s');
      expect(errors.slice(firstError)).toEqual([]);
    });
  }
}
