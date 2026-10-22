import { expect, test, chromium, type Browser, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { auditPanes } from './paneAudit';

// U1 (remaining work 2026-10-19): Edit models, "Add a provider to Hermes" and the study block with
// long RU/EN names (harness `long=1`), light and dark, wide and narrow. Every window's content keeps
// a real inset from its frame, actions never sit on top of text or each other, nothing scrolls
// sideways. Fake backend in a real browser: this is layout evidence, not agent/provider behaviour.
// Screenshots go to .runtime/shots/kb-u1 for a look by eye.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_U1_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-u1');
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [{ name: '1440', width: 1440, height: 900 }, { name: '820', width: 820, height: 760 }] as const;
const INSET = 12;

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

type Box = { x: number; y: number; width: number; height: number };
const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;
const overlaps = (a: Box, b: Box) => a.x < right(b) - 1 && b.x < right(a) - 1 && a.y < bottom(b) - 1 && b.y < bottom(a) - 1;

async function open(theme: 'light' | 'dark', size: (typeof WIDTHS)[number], world = 'study') {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  const url = `${base}/src/kb/test/harness.html?world=${world}&long=1`;
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
}

async function shot(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** Wait until the window has finished opening (its box stops changing), then measure. */
async function settled(dialog: Locator) {
  await expect(dialog).toBeVisible();
  let last = '';
  for (let i = 0; i < 40; i += 1) {
    const now = JSON.stringify(await dialog.boundingBox());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(60);
  }
}

/** Content of a dialog stays inside it with an inset; no element in it scrolls sideways. */
async function checkDialog(dialog: Locator, name: string) {
  const frame = (await dialog.boundingBox())!;
  const problems = await dialog.evaluate((el, inset) => {
    const out: string[] = [];
    const f = el.getBoundingClientRect();
    const describe = (n: Element) => `${n.tagName.toLowerCase()}.${String((n as HTMLElement).className).split(' ')[0]}`;
    for (const n of Array.from(el.querySelectorAll<HTMLElement>('p, input, button, h4, li, footer > *'))) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (n.closest('.kb-modal__head')) continue;
      // Rows inside a scrolling list are clipped by the list itself; check the list, not each row.
      const scroller = n.parentElement?.closest('.kb-addprovider__list, .kb-editmodels__side, .kb-editmodels__main');
      const limit = scroller ? scroller.getBoundingClientRect() : f;
      if (r.left < limit.left - 1 || r.right > limit.right + 1) out.push(`${describe(n)} outside ${Math.round(r.left)}–${Math.round(r.right)}`);
      if (!scroller && (r.left - f.left < inset - 1 || f.right - r.right < inset - 1)) out.push(`${describe(n)} touches the frame`);
    }
    for (const n of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      const cs = getComputedStyle(n);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) out.push(`${describe(n)} scrolls sideways`);
    }
    return out;
  }, INSET);
  expect(problems, `${name}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
  expect(frame.width).toBeGreaterThan(200);
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
    test(`Edit models: inset, title cut, both actions together — ${size.name} ${theme}`, async () => {
      await open(theme, size);
      await page.getByRole('region', { name: 'Chats' }).getByRole('button', { name: /Lecture 8 — cards/ }).click();
      await page.getByTestId('agent-picker').click();
      await page.getByRole('menu', { name: 'Agent and model' }).getByRole('menuitem', { name: 'Edit models…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit models' });
      await dialog.getByRole('navigation', { name: 'Agents and providers' }).getByRole('button', { name: /OpenRouter/ }).click();
      const show = dialog.getByRole('button', { name: 'Show defaults' });
      const hide = dialog.getByRole('button', { name: 'Hide all' });
      await expect(hide).toBeVisible();
      await settled(dialog);
      const [s, h, title, note] = await Promise.all([
        show.boundingBox(), hide.boundingBox(), dialog.locator('.kb-editmodels__title').boundingBox(),
        dialog.locator('.kb-editmodels__main > .kb-editmodels__note').boundingBox(),
      ]);
      // The two actions share one line; neither covers the title or the note under them.
      expect(Math.abs(s!.y - h!.y)).toBeLessThan(2);
      for (const action of [s!, h!]) {
        expect(overlaps(action, title!)).toBe(false);
        expect(overlaps(action, note!)).toBe(false);
      }
      expect(await dialog.locator('.kb-editmodels__title').evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
      await checkDialog(dialog, `edit-models-${size.name}-${theme}`);
      await shot(`edit-models-${size.name}-${theme}`);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });

    test(`Add a provider to Hermes: padded body and footer, long names wrap or cut — ${size.name} ${theme}`, async () => {
      await open(theme, size);
      await page.getByRole('button', { name: /^Settings/ }).click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('button', { name: /Accounts/ }).first().click();
      const block = settings.getByTestId('hermes-providers');
      await block.getByRole('button', { name: 'Add provider' }).click(); // a chip since Accounts & keys v3
      const dialog = page.getByRole('dialog', { name: 'Add a provider to Hermes' });
      await expect(dialog.getByRole('searchbox', { name: 'Find a provider' })).toBeVisible();
      await settled(dialog);
      const foot = (await dialog.locator('.kb-addprovider__foot').boundingBox())!;
      const checked = (await dialog.locator('.kb-addprovider__checked').boundingBox())!;
      const other = (await dialog.getByRole('button', { name: 'Other provider…' }).boundingBox())!;
      expect(overlaps(checked, other)).toBe(false);
      expect(right(checked)).toBeLessThanOrEqual(right(foot) - INSET + 1);
      await checkDialog(dialog, `add-provider-${size.name}-${theme}`);
      await shot(`add-provider-${size.name}-${theme}`);
    });

    test(`study block: long title (click to rename), fold and a long save error keep the buttons — ${size.name} ${theme}`, async () => {
      await open(theme, size);
      await page.getByRole('region', { name: 'Chats' }).getByRole('button', { name: /Lecture 8 — cards/ }).click();
      const deck = page.getByRole('region', { name: /^Flashcards: ИТ-аудит/ });
      const head = (await deck.locator('.kb-st-head').boundingBox())!;
      const grow = (await deck.getByRole('button', { name: 'Bigger — beside the chat' }).boundingBox())!;
      for (const b of [
        (await deck.getByRole('button', { name: /^Rename: ИТ-аудит/ }).boundingBox())!,
        (await deck.getByRole('button', { name: 'Collapse' }).boundingBox())!,
        grow,
      ]) {
        expect(right(b)).toBeLessThanOrEqual(right(head) + 1);
        expect(b.y).toBeGreaterThanOrEqual(head.y - 1);
      }
      // The long title ellipsizes before the size button; it never sits on it.
      expect(overlaps((await deck.getByRole('button', { name: /^Rename: ИТ-аудит/ }).boundingBox())!, grow)).toBe(false);
      await deck.getByRole('button', { name: 'Save to wiki' }).click();
      const error = deck.locator('.kb-st-save .kb-st-error');
      await expect(error).toContainText('Не удалось сохранить');
      // The block's layout animation (the taller 3:2 card) may still be moving the row: measure once it has settled.
      const box = async () => JSON.stringify([await error.boundingBox(), await deck.getByRole('button', { name: 'Save to wiki' }).boundingBox()]);
      await expect.poll(async () => { const a = await box(); await page.waitForTimeout(120); return a === await box(); }, { timeout: 5000 }).toBe(true);
      const save = (await deck.getByRole('button', { name: 'Save to wiki' }).boundingBox())!;
      const deny = (await deck.getByRole('button', { name: 'Deny' }).boundingBox())!;
      const err = (await error.boundingBox())!;
      expect(overlaps(err, save)).toBe(false);
      expect(overlaps(err, deny)).toBe(false);
      expect(err.y).toBeGreaterThanOrEqual(bottom(save) - 1); // its own line under the buttons
      const block = (await deck.boundingBox())!;
      expect(right(save)).toBeLessThanOrEqual(right(block) + 1);
      await shot(`study-error-${size.name}-${theme}`);
      const panes = await page.evaluate(auditPanes);
      expect(panes, `pane violations ${JSON.stringify(panes, null, 1)}`).toEqual([]);
      await deck.getByRole('button', { name: 'Collapse' }).click();
      await expect(deck.getByRole('progressbar')).toBeHidden();
      await shot(`study-folded-${size.name}-${theme}`);
    });
  }
}

test('no console errors', () => {
  expect(consoleErrors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
