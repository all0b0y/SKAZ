import { expect, test, chromium, type Browser, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// 0.3.1 F7 / F7-a in a real browser on the shared fake backend (frontend/src/kb/test/harness.html,
// `world=study`: chats, materials, wiki pages and the saved deck). In every list:
// - no box and no room kept for it while nothing is selected (not even on hover);
// - ⌘-click on one row → the box is on every row of that list at once; a click outside clears it;
// - ⌘A with the pointer over the list (focus elsewhere) selects all of it; Esc clears;
// - the box slides in (a width transition) unless reduced motion is asked for.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_F7_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-f7');

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

const rail = (name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${name}`) });

interface Boxes { rows: number; selected: number; widths: number[]; opacities: number[]; textLeft: number[] }

/** The boxes of the list holding `grid` (the element with the list's keys and `data-selecting`). */
async function boxes(grid: Locator): Promise<Boxes> {
  return grid.evaluate((el) => {
    const list = el.closest('[data-sel-list]') ?? el;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-sel-id]'));
    const box = (r: HTMLElement) => r.querySelector<HTMLElement>('[data-sel-box]');
    return {
      rows: rows.length,
      selected: rows.filter((r) => r.getAttribute('aria-selected') === 'true').length,
      widths: rows.map((r) => Math.round((box(r)?.getBoundingClientRect().width ?? -1) * 10) / 10),
      // What shows: the slot's opacity times the box's own (a dashed box that can't be selected is dimmer).
      opacities: rows.map((r) => {
        const b = box(r);
        if (!b) return -1;
        const inner = b.querySelector('.kb-selbox');
        return Number(getComputedStyle(b).opacity) * (inner ? Number(getComputedStyle(inner).opacity) : 1);
      }),
      textLeft: rows.map((r) => Math.round((r.querySelector('.kb-row__text, .kb-allchats__main, .kb-amt__open, .kb-deck__q')?.getBoundingClientRect().left ?? 0))),
    };
  });
}

async function hidden(grid: Locator, what: string) {
  const b = await boxes(grid);
  expect(b.rows, `${what}: rows`).toBeGreaterThan(1);
  expect(b.selected, `${what}: nothing selected`).toBe(0);
  expect(b.widths.every((w) => w === 0), `${what}: no room kept for the box ${JSON.stringify(b.widths)}`).toBe(true);
  return b;
}

async function shown(grid: Locator, what: string, selected?: number) {
  const b = await boxes(grid);
  if (selected !== undefined) expect(b.selected, `${what}: selected`).toBe(selected);
  expect(b.widths.every((w) => w >= 15), `${what}: the box on every row ${JSON.stringify(b.widths)}`).toBe(true);
  expect(b.opacities.every((o) => o > 0.3), `${what}: the box visible ${JSON.stringify(b.opacities)}`).toBe(true);
  return b;
}

/** A spot outside every list: the title bar's middle. */
async function clickOutside() {
  const bar = (await page.getByTestId('titlebar').boundingBox())!;
  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
}

async function blur() {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
}

/** The whole F7 round on one list. `first` is a row's main button (the one a plain click opens). */
async function round(name: string, grid: Locator, first: Locator) {
  // Hover alone shows nothing and keeps no room.
  await first.hover();
  const before = await hidden(grid, `${name} hovered`);
  await page.screenshot({ path: path.join(shots, `${name}-idle.png`) });

  // ⌘-click: the box on every row, the text moves right to make room.
  await first.click({ modifiers: ['ControlOrMeta'] });
  const after = await shown(grid, `${name} ⌘-click`, 1);
  expect(after.textLeft[0]! - before.textLeft[0]!, `${name}: the row widens for the box`).toBeGreaterThanOrEqual(14);
  await page.screenshot({ path: path.join(shots, `${name}-selected.png`) });

  // A click outside: cleared at once, the room goes too.
  await clickOutside();
  await hidden(grid, `${name} after a click outside`);

  // ⌘A with the pointer over the list and the focus elsewhere.
  await blur();
  await first.hover();
  await page.keyboard.press('ControlOrMeta+a');
  const all = await shown(grid, `${name} ⌘A over the list`);
  expect(all.selected, `${name}: ⌘A selected the list`).toBeGreaterThan(1);
  await page.keyboard.press('Escape');
  await hidden(grid, `${name} after Esc`);
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
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}/src/kb/test/harness.html?world=study`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/src/kb/test/harness.html?world=study`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test('side chats and all chats', async () => {
  await rail('Chats').click();
  const side = page.getByRole('region', { name: 'Chats' });
  const grid = side.getByRole('grid').first();
  await round('side-chats', grid, grid.getByRole('row').first().getByRole('button').first());

  await side.getByRole('button', { name: /^All chats/ }).click();
  const all = page.getByRole('region', { name: 'All chats' });
  const allGrid = all.getByRole('grid').first();
  await round('all-chats', allGrid, allGrid.getByRole('row').first().locator('.kb-allchats__main'));
});

test('side materials and all materials', async () => {
  await rail('Materials').click();
  const side = page.getByRole('region', { name: 'Materials' });
  const grid = side.getByRole('grid').first();
  await round('side-materials', grid, grid.getByRole('row').first().getByRole('button').first());

  await page.getByTestId('all-materials').click();
  const center = page.getByRole('region', { name: 'All materials' });
  const table = center.getByRole('grid');
  await round('all-materials', table, table.locator('tbody tr').first().locator('.kb-amt__open'));
  await center.getByRole('button', { name: 'Close all materials' }).click();
});

test('wiki side pages', async () => {
  await rail('Wiki').click();
  const side = page.getByRole('region', { name: 'Wiki' });
  await side.getByRole('button', { name: /^Concepts/ }).click();
  const grid = side.getByRole('grid').first();
  await expect(grid.getByRole('row').nth(1)).toBeVisible();
  await round('wiki-pages', grid, grid.getByRole('row').first().getByRole('button').first());
});

test('the deck page', async () => {
  await page.evaluate(() => (window as unknown as { __kbFake: { services: { ui: { getState: () => { openDocument: (t: unknown) => void } } } } })
    .__kbFake.services.ui.getState().openDocument({ type: 'page', id: 'p-deck' }));
  const grid = page.getByRole('grid', { name: 'Cards' });
  await expect(grid.getByRole('row').nth(1)).toBeVisible();
  await round('deck', grid, grid.getByRole('row').first().locator('.kb-deck__q'));
});

test('the box slides in, except with reduced motion', async () => {
  await rail('Chats').click();
  const grid = page.getByRole('region', { name: 'Chats' }).getByRole('grid').first();
  const duration = () => grid.evaluate((el) => getComputedStyle(el.querySelector('[data-sel-box]')!).transitionDuration);
  expect(await duration()).toMatch(/^0s(, 0s)*$/);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await duration()).not.toMatch(/^0s(, 0s)*$/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(consoleErrors).toEqual([]);
});
