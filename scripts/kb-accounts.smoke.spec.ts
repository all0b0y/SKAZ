import { expect, test, chromium, type Browser, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// Accounts & keys v3 (confirmed 2026-10-21, .dev/ui-redesign/accounts/accounts-v3.html, frames3/):
// the real Settings screen on the browser fake (harness `accounts=v3`): Hermes chips, a provider's
// window (signed out, Remove asked inside), several keys, adding a key, the whole catalogue, search,
// adding (Terminal) and checked — at 1440 and 820, light and dark. Layout evidence only: no agent,
// provider or Terminal is involved. Screenshots go to .runtime/shots/kb-accounts for a look by eye.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_ACCOUNTS_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-accounts');
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [{ name: '1440', width: 1440, height: 900 }, { name: '820', width: 820, height: 760 }] as const;

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

type Box = { x: number; y: number; width: number; height: number };
const right = (b: Box) => b.x + b.width;

async function openAccounts(theme: 'light' | 'dark', size: (typeof WIDTHS)[number], tweak?: string) {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  const url = `${base}/src/kb/test/harness.html?accounts=v3`;
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
  // The world is the fake backend's own object: a scene changes it before Settings reads it.
  if (tweak === 'signedout') {
    await page.evaluate(() => {
      const w = (window as unknown as { __kbFake: { world: { hermesProviders: { providers: Array<{ credentials: Array<{ state: string }> }> } } } }).__kbFake.world;
      w.hermesProviders.providers[0]!.credentials[0]!.state = 'signed_out';
    });
  }
  await page.getByRole('button', { name: /^Settings/ }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation').getByRole('button', { name: /^Accounts & keys/ }).click();
  const block = settings.getByTestId('hermes-providers');
  await expect(block.getByRole('button', { name: /^OpenRouter/ })).toBeVisible();
  return { settings, block };
}

async function shot(name: string) {
  await page.mouse.move(1, 1); // no hover left from the last click
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

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

/** Nothing in a window or the settings pane scrolls sideways or sticks out of its frame. */
async function checkInside(frame: Locator, name: string) {
  const problems = await frame.evaluate((el) => {
    const out: string[] = [];
    const f = el.getBoundingClientRect();
    const describe = (n: Element) => `${n.tagName.toLowerCase()}.${String((n as HTMLElement).className).split(' ')[0]}`;
    for (const n of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) out.push(`${describe(n)} scrolls sideways`);
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || n.closest('.kb-addprovider__list')) continue;
      if (r.left < f.left - 1 || r.right > f.right + 1) out.push(`${describe(n)} outside ${Math.round(r.left)}–${Math.round(r.right)}`);
    }
    return out;
  });
  expect(problems, `${name}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
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
    const tag = `${size.name}-${theme}`;

    test(`normal: four agents, Hermes chips without numbers, Add provider last — ${tag}`, async () => {
      const { settings, block } = await openAccounts(theme, size);
      const chips = block.getByRole('list', { name: 'Hermes providers' }).getByRole('listitem');
      await expect(chips).toHaveText(['ChatGPT', 'OpenRouter', 'Add provider']);
      // The chips sit under the Hermes row's text, inside the pane.
      const pane = (await block.boundingBox())!;
      for (const chip of await chips.all()) expect(right((await chip.boundingBox())!)).toBeLessThanOrEqual(right(pane) + 1);
      await expect(settings.getByRole('group', { name: 'Codex' }).getByRole('button', { name: 'More for Codex' })).toBeVisible();
      await expect(settings.getByRole('group', { name: 'OpenCode' }).getByRole('button', { name: 'Sign in' })).toBeVisible();
      await checkInside(settings.locator('.kb-settings__content').first(), `normal-${tag}`);
      // The agent rows in view, as in the mock-up (the pane scrolls on a short window).
      await settings.getByRole('group', { name: 'Codex' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await shot(`normal-${tag}`);
    });

    test(`provider window: signed out, then Remove asked inside — ${tag}`, async () => {
      const { block } = await openAccounts(theme, size, 'signedout');
      await block.getByRole('button', { name: /^ChatGPT/ }).click();
      const win = page.getByRole('dialog', { name: 'ChatGPT' });
      await settled(win);
      await expect(win.getByRole('note')).toContainText('The sign-in has expired.');
      await checkInside(win, `signedout-${tag}`);
      await shot(`signedout-${tag}`);
      await win.getByRole('button', { name: 'Remove…' }).click();
      await expect(win.getByRole('group', { name: 'Remove ChatGPT from Hermes?' })).toBeVisible();
      await checkInside(win, `remove-${tag}`);
      await shot(`remove-${tag}`);
    });

    test(`several keys, then Add another key — ${tag}`, async () => {
      const { block } = await openAccounts(theme, size);
      await block.getByRole('button', { name: /^OpenRouter/ }).click();
      const win = page.getByRole('dialog', { name: 'OpenRouter' });
      await settled(win);
      await expect(win.getByRole('radiogroup', { name: 'Key in use' }).getByRole('radio')).toHaveCount(3);
      await checkInside(win, `keys-${tag}`);
      await shot(`keys-${tag}`);
      await win.getByRole('button', { name: 'Add another key…' }).click();
      await win.getByRole('textbox', { name: 'Name' }).fill('Team');
      await checkInside(win, `addkey-${tag}`);
      await shot(`addkey-${tag}`);
    });

    test(`Add provider: catalogue, search, adding in Terminal, checked — ${tag}`, async () => {
      const { block } = await openAccounts(theme, size);
      await block.getByRole('button', { name: 'Add provider' }).click();
      const add = page.getByRole('dialog', { name: 'Add a provider to Hermes' });
      await settled(add);
      await expect(add.locator('.kb-addprovider__item')).toHaveCount(45);
      await checkInside(add, `add-${tag}`);
      await shot(`add-${tag}`);
      await add.getByRole('searchbox', { name: 'Find a provider' }).fill('kimi');
      await expect(add.locator('.kb-addprovider__item')).toHaveCount(2);
      await shot(`search-${tag}`);
      await add.locator('.kb-addprovider__item[data-provider="kimi-coding"]').click();
      await expect(block.getByRole('status')).toContainText('Finish in Terminal.');
      await block.scrollIntoViewIfNeeded();
      await shot(`adding-${tag}`);
      await page.evaluate(() => {
        const w = (window as unknown as { __kbFake: { world: { hermesProviders: { terminal: { state: string }; providers: unknown[] } } } }).__kbFake.world;
        w.hermesProviders.terminal.state = 'done';
        w.hermesProviders.providers.push({ id: 'kimi-coding', name: 'Kimi / Moonshot', order: 2, free_tier: null, credentials: [
          { index: 1, id: 'k1m1', label: 'api-key-1', auth_type: 'api_key', priority: 0, state: 'ready', until: null, detail: null, current: true },
        ] });
        window.dispatchEvent(new Event('focus'));
      });
      await expect(block.getByText('Kimi / Moonshot added and ready. Hermes tries it 3rd.')).toBeVisible();
      await shot(`checked-${tag}`);
    });
  }
}

test('no console errors', () => {
  expect(consoleErrors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
