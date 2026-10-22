import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// Wiki terms v1, variant A (confirmed 2026-10-21) in a real browser on the shared fake backend
// (frontend/src/kb/test/harness.tsx): “?” on a wiki page and on the Wiki panel, and “Show…” in
// Settings → Wiki → Help open the legend — 15 labels, one line each. Light and dark at 1440 and 820:
// the legend is inside the window; at the normal window it needs no scrolling; console clean.
// Compare with .dev/ui-redesign/wiki-terms/frames/A-page-*.png and A-settings-*.png.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_WIKI_TERMS_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-wiki-terms');
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [{ width: 1440, height: 900 }, { width: 820, height: 640 }] as const;
const LEGEND = 'What the wiki labels mean';

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

type Fake = { services: { ui: { getState: () => {
  openDocument: (t: { type: 'page'; id: string }) => void;
  openSettings: (section: string) => void;
} } } };

async function open(theme: 'light' | 'dark', size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${base}/src/kb/test/harness.html`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/src/kb/test/harness.html`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
}

/** The legend is inside the window, its rows are one line each; returns whether it had to scroll. */
async function checkLegend(name: string) {
  const legend = page.getByRole('dialog', { name: LEGEND });
  await expect(legend).toBeVisible();
  await expect(legend.getByRole('term')).toHaveCount(15);
  await page.waitForTimeout(400);
  const report = await legend.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.kb-legend__row'));
    const tall = rows.filter((row) => row.getBoundingClientRect().height > 30).map((row) => row.dataset.term);
    const cut = Array.from(el.querySelectorAll<HTMLElement>('.kb-legend__meaning'))
      .filter((m) => m.scrollWidth > m.clientWidth + 1).map((m) => m.textContent);
    // A sample wider than its column runs into the meaning.
    const overlap = rows.filter((row) => {
      const draw = row.querySelector('.kb-legend__draw')!.getBoundingClientRect();
      const meaning = row.querySelector('.kb-legend__meaning')!.getBoundingClientRect();
      return draw.right > meaning.left;
    }).map((row) => row.dataset.term);
    return {
      inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      scrolls: el.scrollHeight > el.clientHeight + 1, width: Math.round(r.width), height: Math.round(r.height), tall, cut, overlap,
    };
  });
  console.log(name, JSON.stringify(report));
  expect.soft(report.inside, `${name}: legend inside the window`).toBe(true);
  expect.soft(report.tall, `${name}: rows on more than one line`).toEqual([]);
  expect.soft(report.overlap, `${name}: samples running into the meaning`).toEqual([]);
  return report;
}

async function shot(name: string) {
  await page.evaluate(() => document.fonts.ready);
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

test('a small window: the legend stays inside it and scrolls by itself', async () => {
  await open('light', { width: 820, height: 480 });
  await page.evaluate(() => (window as unknown as { __kbFake: Fake }).__kbFake.services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }));
  const doc = page.getByRole('complementary', { name: 'Document' });
  await expect(doc.getByRole('heading', { level: 2, name: 'Entropy' })).toBeVisible();
  await doc.getByRole('button', { name: 'What these labels mean' }).click();
  const report = await checkLegend('page-light-820x480');
  expect(report.scrolls, 'scrolls inside itself').toBe(true);
  await shot('page-light-820x480');
  const legend = page.getByRole('dialog', { name: LEGEND });
  await legend.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(legend.getByRole('button', { name: 'Models' })).toBeInViewport();
  await shot('page-light-820x480-end');
  expect(consoleErrors, 'console errors').toEqual([]);
});

for (const theme of THEMES) {
  for (const size of WIDTHS) {
    test(`legend on “?” of a wiki page, the Wiki panel and Settings — ${size.width} ${theme}`, async () => {
      const tag = `${theme}-${size.width}`;
      await open(theme, size);
      // A wiki page: “?” in its header.
      await page.evaluate(() => (window as unknown as { __kbFake: Fake }).__kbFake.services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }));
      const doc = page.getByRole('complementary', { name: 'Document' });
      await expect(doc.getByRole('heading', { level: 2, name: 'Entropy' })).toBeVisible();
      await doc.getByRole('button', { name: 'What these labels mean' }).click();
      const onPage = await checkLegend(`page-${tag}`);
      if (size.width === 1440) expect.soft(onPage.scrolls, `page-${tag}: no scrolling at the normal window`).toBe(false);
      await shot(`page-${tag}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: LEGEND })).toHaveCount(0);
      await expect(doc.getByRole('button', { name: 'What these labels mean' })).toBeFocused();
      // The Wiki panel: “?” beside “Sections” (a narrow window has no room for the panel beside a document).
      await doc.getByRole('button', { name: 'Close document' }).click();
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Wiki/ }).click();
      const side = page.getByRole('region', { name: 'Wiki' });
      await side.getByRole('button', { name: 'What these labels mean' }).click();
      await checkLegend(`panel-${tag}`);
      await shot(`panel-${tag}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: LEGEND })).toHaveCount(0);
      // Settings → Wiki → Help → Wiki terms → Show…
      await page.evaluate(() => (window as unknown as { __kbFake: Fake }).__kbFake.services.ui.getState().openSettings('wiki'));
      const settings = page.getByRole('dialog', { name: 'Settings' });
      const row = settings.getByRole('group', { name: 'Wiki terms' });
      await row.scrollIntoViewIfNeeded();
      await shot(`settings-row-${tag}`);
      await row.getByRole('button', { name: 'Show…' }).click();
      await checkLegend(`settings-${tag}`);
      await shot(`settings-${tag}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: LEGEND })).toHaveCount(0);
      await expect(settings).toBeVisible();
      expect(consoleErrors, 'console errors').toEqual([]);
    });
  }
}
