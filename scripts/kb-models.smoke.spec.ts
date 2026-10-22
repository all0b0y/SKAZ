import { expect, test, chromium, type Browser, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// Models screen v2 (confirmed 2026-10-20): grouped Chats / Wiki / Recordings; the wiki model and the
// recognition check are one picker button on the label's line, right-aligned, hints and warnings
// under the label; the menu shows each agent's last model and reasoning at the bottom. Light and
// dark, wide and narrow. Fake backend in a real browser: layout evidence, not agent behaviour.
// Screenshots go to .runtime/shots/kb-models for a look by eye.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_MODELS_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-models');
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [{ name: '1440', width: 1440, height: 900 }, { name: '820', width: 820, height: 760 }] as const;

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

type Box = { x: number; y: number; width: number; height: number };
const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;
const overlaps = (a: Box, b: Box) => a.x < right(b) - 1 && b.x < right(a) - 1 && a.y < bottom(b) - 1 && b.y < bottom(a) - 1;

async function openModels(theme: 'light' | 'dark', size: (typeof WIDTHS)[number]) {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  const url = `${base}/src/kb/test/harness.html?world=study`;
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /^Models/ }).click();
  await expect(dialog.getByRole('group', { name: 'Wiki model' })).toBeVisible();
  return dialog;
}

async function shot(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** The picker sits on the label's line at the right edge — or, when the row is too narrow, under it, still at the right edge. */
async function checkPickerRow(row: Locator, name: string, wide: boolean) {
  // The row reads its setting on open: measure once the picker is there, all boxes at one moment.
  await expect(row.locator('.kb-picker--field')).toBeVisible();
  await page.waitForTimeout(100);
  const { r, text, label, button } = await row.evaluate((el) => {
    const box = (n: Element) => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { r: box(el), text: box(el.querySelector('.kb-srow__text')!), label: box(el.querySelector('.kb-srow__label')!),
      button: box(el.querySelector('.kb-picker--field')!) };
  });
  if (process.env.SKAZ_DEBUG) console.log(name, JSON.stringify({ r, text, label, button }));
  expect(right(button), `${name}: button at the right edge`).toBeGreaterThan(right(r) - 3);
  expect(overlaps(button, text), `${name}: button over the label`).toBe(false);
  expect(button.width, `${name}: button keeps its width`).toBeGreaterThanOrEqual(Math.min(249, r.width));
  if (wide) {
    // Same line as the label (the v1 complaint: it slid left under the label).
    expect(button.y, `${name}: on the label's line`).toBeLessThan(bottom(label));
    expect(bottom(button), `${name}: on the label's line`).toBeGreaterThan(label.y);
  }
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
    test(`Models v2: groups, pickers on the label line, memory in the menu — ${size.name} ${theme}`, async () => {
      const dialog = await openModels(theme, size);
      const content = dialog.locator('.kb-settings__content');
      await expect(content.locator('.kb-sgroup__title')).toHaveText(['Chats', 'Wiki', 'Recordings']);
      const wide = size.width >= 1200;
      const wiki = dialog.getByRole('group', { name: 'Wiki model' });
      const rec = dialog.getByRole('group', { name: 'Recognition check' });
      await checkPickerRow(wiki, 'wiki', wide);
      await checkPickerRow(rec, 'recognition', wide);
      expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await shot(`models-${size.name}-${theme}`);

      // Choose a Codex model, then a Claude Code one: the menu now shows Codex's last choice.
      await wiki.getByRole('button', { name: /^Wiki model:/ }).click();
      let menu = page.getByRole('menu', { name: 'Wiki model' });
      await menu.getByRole('group', { name: 'Codex' }).getByRole('menuitemradio').first().click();
      await expect(wiki.getByRole('button', { name: /^Wiki model: Codex,/ })).toBeVisible();
      await wiki.getByRole('button', { name: /^Wiki model:/ }).click();
      menu = page.getByRole('menu', { name: 'Wiki model' });
      await menu.getByRole('group', { name: 'Claude Code' }).getByRole('menuitemradio').first().click();
      await expect(wiki.getByRole('button', { name: /^Wiki model: Claude Code,/ })).toBeVisible();
      await wiki.getByRole('button', { name: /^Wiki model:/ }).click();
      menu = page.getByRole('menu', { name: 'Wiki model' });
      await expect(menu.getByRole('group', { name: 'Codex' })).toContainText('last:');
      await expect(menu.getByRole('radiogroup', { name: 'Reasoning' })).toBeVisible();
      const m = (await menu.boundingBox())!;
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(right(m)).toBeLessThanOrEqual(size.width + 1);
      expect(m.y).toBeGreaterThanOrEqual(0);
      await shot(`models-wiki-menu-${size.name}-${theme}`);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await checkPickerRow(wiki, 'wiki after a choice', wide);

      await rec.getByRole('button', { name: /^Recognition check:/ }).click();
      const recMenu = page.getByRole('menu', { name: 'Recognition check' });
      await expect(recMenu.getByRole('menuitemradio').nth(0)).toHaveText('Same as wiki model');
      await expect(recMenu.getByRole('menuitemradio').nth(1)).toHaveText('Off');
      await shot(`models-recognition-menu-${size.name}-${theme}`);
      await page.keyboard.press('Escape');
    });
  }
}

test('no console errors', () => {
  expect(consoleErrors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
