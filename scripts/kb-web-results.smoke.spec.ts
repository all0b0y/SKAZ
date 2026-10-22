import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// Web results v1 «Folded line + quiet rows» (confirmed 2026-10-21) in a real browser on the shared fake
// backend: folded by default, quiet title · site rows, the Add to wiki icon on hover, «In library»,
// a one-line error with Retry, «Show N more». Compare with .dev/ui-redesign/web-results/frames/A-*.png.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_WEB_RESULTS_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-web-results');
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [{ width: 1440, height: 900 }, { width: 820, height: 640 }] as const;
const LINKS = [
  ['TOGAF — The Open Group', 'opengroup.org'], ['The TOGAF Standard', 'publications.opengroup.org'],
  ['Paywalled TOGAF page', 'news.example.com'], ['TOGAF Publications', 'opengroup.org'],
  ['TOGAF Certification Portfolio', 'opengroup.org'], ['TOGAF® Version 9', 'opengroup.org'],
  ['Where to Get Official Practice Tests for The Open Group Certification Exams – The Open Group Help Center', 'help.opengroup.org'],
  ['The TOGAF Standard, Version 9.2 - Introduction', 'togafcertified.com'], ['TOGAF® Library', 'opengroup.org'],
];

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

async function seed() {
  await page.evaluate(({ links }) => {
    type W = { chats: Array<{ id: string; title: string; messages: unknown[]; cursor: number; engine: string }> };
    const world = (window as unknown as { __kbFake: { world: W } }).__kbFake.world;
    const c1 = world.chats.find((c) => c.id === 'c1')!;
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const q = 'А найди мне источник TOGAF в интернете и скинь ссылку';
    c1.title = 'TOGAF';
    c1.engine = 'codex';
    c1.messages = [
      { id: 'c1-u1', seq: 1, role: 'user', created_at: at(3), engine: null, model: null, state: 'done', parts: [{ type: 'text', text: q }],
        failure: null, saved_page_id: null, input: { text: q, mentions: [], quotes: [], attachments: [] } },
      { id: 'c1-a1', seq: 2, role: 'assistant', created_at: at(2), engine: 'codex', model: 'gpt-6.1-sol', state: 'done', failure: null, saved_page_id: null, input: null,
        parts: [
          { type: 'tool', name: 'skaz_web_search', label: 'Used skaz_web_search' },
          { type: 'web_search', id: 'web-t1', engine: 'codex', searcher: 'codex', query: 'TOGAF official source', allowed_domains: [], blocked_domains: [],
            status: 'allowed', auto: false, reason: null, links: links.map(([title, site], i) => ({ title, site, url: i === 2 ? 'https://news.example.com/signin/togaf' : `https://${site}/togaf/${i}` })) },
          { type: 'text', text: 'Официальный источник TOGAF — сайт The Open Group: [TOGAF — The Open Group](https://opengroup.org/togaf/0). Сам стандарт лежит в [The TOGAF Standard](https://publications.opengroup.org/togaf/1).' },
        ] },
    ];
    c1.cursor = 2;
  }, { links: LINKS });
}

async function open(theme: 'light' | 'dark', size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
  await seed();
  await page.evaluate(() => (window as unknown as { __kbFake: { services: { chats: { getState: () => { open: (id: string) => void } } } } })
    .__kbFake.services.chats.getState().open('c1'));
  return page.getByRole('region', { name: 'Chat' });
}

async function shot(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  info.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  server = await createServer({
    configFile: false,
    root: path.join(root, 'frontend'),
    plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'frontend/src') } },
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer!.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  browser = await chromium.launch();
  page = await browser.newPage({ deviceScaleFactor: 2 });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

for (const theme of THEMES) {
  for (const size of WIDTHS) {
    test(`web results folded, rows, add, error, more — ${size.width} ${theme}`, async () => {
      const tag = `${theme}-${size.width}`;
      const chat = await open(theme, size);
      const fold = chat.getByRole('button', { name: /Searched the web · TOGAF official source · 9 links/ });
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      await expect(chat.getByText(/Looked at/)).toHaveCount(0);
      await shot(`folded-${tag}`);

      await fold.click();
      const list = chat.getByRole('list', { name: 'From the web' });
      await expect(list.getByRole('link')).toHaveCount(5);
      const rows = list.locator('.kb-web__link');
      const add = rows.nth(1).getByRole('button', { name: 'Add to wiki' });
      await page.mouse.move(5, 5);
      await expect.poll(() => add.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
      await rows.nth(1).hover();
      await expect.poll(() => add.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      await add.hover();
      await page.waitForTimeout(600);
      await shot(`hover-${tag}`);

      await add.click();
      await expect(rows.nth(1).getByRole('status')).toHaveText('In library');
      await rows.nth(2).getByRole('button', { name: 'Add to wiki' }).click();
      await expect(list.getByRole('alert')).toContainText('Save the page as PDF and import it.');
      await expect(list.getByRole('button', { name: 'Retry' })).toBeVisible();
      await page.mouse.move(5, 5);
      await shot(`added-error-${tag}`);
      // One-line rows: nothing spills out of the chat column.
      const spill = await list.evaluate((el) => [...el.querySelectorAll('.kb-web__row, .kb-web__error')]
        .filter((r) => r.scrollWidth > r.clientWidth + 1).map((r) => r.className));
      expect(spill).toEqual([]);

      await chat.getByRole('button', { name: 'Show 4 more' }).click();
      await expect(list.getByRole('link')).toHaveCount(9);
      await shot(`all-${tag}`);
      await fold.click();
      await expect(list).toHaveCount(0);
      expect(consoleErrors).toEqual([]);
    });
  }
}
