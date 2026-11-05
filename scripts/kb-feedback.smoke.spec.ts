import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import type { KbAnswerBlockPart, KbMessage, KbWebSearchPart } from '../frontend/src/api/kb/types.gen';
import type { createServices } from '../frontend/src/kb/state/context';
import type { FakeWorld } from '../frontend/src/kb/test/fakeKb';

// Real renderer and styles; authored API-seam data, no profile, providers or external network.
type Host = Window & { __kbFake: { world: FakeWorld; services: ReturnType<typeof createServices> } };
const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime/shots/kb-feedback');
let server: ViteDevServer;
let base = '';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  server = await createServer({ configFile: false, root: path.join(root, 'frontend'), plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'frontend/src') } },
    server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address !== 'object') throw new Error('No browser harness address');
  base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

async function open(page: Page, theme: 'light' | 'dark', width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await page.evaluate((theme) => (window as unknown as Host).__kbFake.services.prefs.getState().set({ theme, motion: 'off' }), theme);
}

/** Opt into the real Beta control in this disposable browser harness, never the user's profile. */
async function enableSearchBeta(page: Page) {
  await page.getByRole('button', { name: /^Settings(?:,|$)/ }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Search', exact: true }).click();
  const beta = settings.getByRole('switch', { name: 'Beta search features', exact: true });
  await expect(beta).toBeEnabled();
  await expect(beta).not.toBeChecked();
  await expect(settings.getByRole('group', { name: 'Blocked sites', exact: true })).toBeVisible();
  await expect(settings.getByRole('group', { name: 'Only these sites', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('group', { name: 'Preferred sites', exact: true })).toHaveCount(0);
  await beta.click();
  await expect(beta).toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as unknown as Host).__kbFake.world.searchSettings?.beta)).toBe(true);
  await expect(settings.getByRole('group', { name: 'Only these sites', exact: true })).toBeVisible();
  return settings;
}

async function answer(page: Page, parts: KbMessage['parts']) {
  await page.evaluate((parts) => {
    const f = (window as unknown as Host).__kbFake;
    const chat = f.world.chats.find((c) => c.id === 'c1')!;
    chat.title = 'Feedback regression';
    chat.messages = [{ id: 'feedback-answer', seq: 1, role: 'assistant', engine: 'claude_code', model: null,
      state: 'done', failure: null, saved_page_id: null, input: null, created_at: new Date().toISOString(), parts }];
    chat.cursor = 1;
    f.services.chats.getState().open('c1');
  }, parts);
}

const web: KbWebSearchPart = {
  type: 'web_search', id: 'feedback-web', engine: 'claude_code', searcher: null, call_id: 'feedback-native',
  query: 'Approved controlled query', allowed_domains: [], blocked_domains: [], status: 'allowed', auto: false,
  reason: null, links: [{ title: 'Controlled public source', url: 'https://example.org/evidence', site: 'example.org' }],
  execution: 'done', started_at: '2026-11-01T12:00:00Z', duration_ms: 640, execution_error: null,
};

const compare: KbAnswerBlockPart = {
  type: 'answer_block', id: 'feedback-compare', state: 'ready', hidden: 0, error: null, raw: null,
  beside: false, link: null, markdown: null, sources: [],
  block: { kind: 'compare', title: 'Feedback table',
    columns: ['Controlled technique Alpha', 'Controlled technique Beta', 'Controlled technique Gamma',
      'Controlled technique Delta', 'Controlled technique Epsilon', 'Controlled technique Zeta'],
    rows: [{ id: 'r1', label: 'Characteristic', cells: Array.from({ length: 6 }, (_, i) => ({
      id: `r1c${i}`, text: `Controlled example ${i + 1}: several words to read without broken letters.`, src: [], agent: true,
    })) }],
  },
};

for (const theme of ['light', 'dark'] as const) {
  test(`typed site rules save from both globes without Enter — ${theme}`, async ({ page }) => {
    await open(page, theme);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let settings = await enableSearchBeta(page);
    for (const [label, key, site] of [
      ['Blocked sites', 'never', 'blocked.example.org'],
      ['Only these sites', 'only', 'only.example.org'],
      ['Preferred sites', 'prefer', 'preferred.example.org'],
    ] as const) {
      const group = settings.getByRole('group', { name: label, exact: true });
      await group.getByRole('button', { name: 'Add site', exact: true }).click();
      await group.getByRole('textbox').fill(`https://www.${site}/evidence`);
      await expect(group.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
      if (key === 'only') await settings.getByRole('heading', { name: 'Search', exact: true }).click();
      else await group.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(group.getByText(site, { exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate((key) => (window as unknown as Host).__kbFake.world.searchSettings?.[key], key)).toContain(site);
    }
    await settings.getByRole('switch', { name: 'Only these sites', exact: true }).click();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /^Settings(?:,|$)/ }).click();
    settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(settings.getByRole('group', { name: 'Only these sites', exact: true }).getByText('only.example.org')).toBeVisible();
    await expect(settings.getByRole('switch', { name: 'Only these sites', exact: true })).toBeChecked();
    await page.screenshot({ path: path.join(shots, `saved-site-settings-${theme}.png`) });
    await settings.getByRole('button', { name: 'Close', exact: true }).click();

    await page.evaluate(() => (window as unknown as Host).__kbFake.services.chats.getState().open('c1'));
    const composer = page.getByTestId('composer');
    const globe = composer.getByRole('button', { name: /^Search rules for this chat/ });
    await globe.click();
    let panel = composer.getByRole('dialog', { name: 'Search and sources for this chat' });
    let only = panel.getByRole('region', { name: 'Web · only these sites' });
    await only.getByRole('button', { name: 'Add site', exact: true }).click();
    await only.getByRole('textbox').fill('https://chat.example.org/evidence');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as Host).__kbFake.world.chatSearchRules?.c1?.web?.only)).toContain('chat.example.org');
    await globe.click();
    panel = composer.getByRole('dialog', { name: 'Search and sources for this chat' });
    only = panel.getByRole('region', { name: 'Web · only these sites' });
    await expect(only.getByText('chat.example.org', { exact: true })).toBeVisible();
    await only.getByRole('button', { name: 'Add site', exact: true }).click();
    await only.getByRole('textbox').fill('not a site');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(only.getByRole('alert')).toHaveText('Write it like example.com.');
    await only.getByRole('textbox').press('Escape');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test(`general knowledge is one quiet informational disclosure — ${theme}`, async ({ page }) => {
    await open(page, theme);
    await answer(page, [{ type: 'knowledge' }, { type: 'knowledge' }, compare,
      { type: 'text', text: 'Controlled explanation and example.' }]);
    const note = page.getByRole('note', { name: 'Using general knowledge' });
    await expect(note).toHaveCount(1);
    const fold = note.getByRole('button', { name: 'Using general knowledge' });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await fold.hover();
    await expect(fold).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await fold.click();
    await expect(note).toContainText('not evidence from your materials');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: /Allow once|Allow in this chat|Deny/ })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(note.locator('[data-selectable]')).toHaveCount(0);
    await page.screenshot({ path: path.join(shots, `knowledge-notice-${theme}.png`) });
  });

  test(`web fold has no hover or expanded fill — ${theme}`, async ({ page }) => {
    await open(page, theme);
    await answer(page, [web]);
    const fold = page.getByRole('button', { name: 'Searched the web · Approved controlled query · 1 link' });
    await expect(fold).toBeVisible();
    await fold.hover();
    await page.screenshot({ path: path.join(shots, `web-hover-${theme}.png`) });
    await expect(fold).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(fold).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.getByRole('link', { name: 'Controlled public source', exact: true })).toBeVisible();
    const boxes = await fold.evaluate((el) => ({
      title: el.querySelector('b')!.getBoundingClientRect().left,
      globe: el.parentElement!.querySelector('[data-stipple-globe]')!.getBoundingClientRect().right,
    }));
    expect(boxes.globe).toBeLessThanOrEqual(boxes.title);
  });

  test(`Chats header omits duplicate search; global and All chats search remain — ${theme}`, async ({ page }) => {
    await open(page, theme);
    const side = page.getByRole('region', { name: 'Chats', exact: true });
    await expect(side.getByRole('button', { name: /^All chats/ })).toBeVisible();
    await expect(side.getByRole('button', { name: 'Find in chats', exact: true })).toHaveCount(0);
    await expect(side.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(shots, `sidebar-no-duplicate-search-${theme}.png`) });
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Search', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search', exact: true })).toHaveCount(0);
    await side.getByRole('button', { name: /^All chats/ }).click();
    await expect(page.getByRole('region', { name: 'All chats', exact: true }).getByRole('searchbox', { name: 'Find in chats' })).toBeVisible();
  });

  test(`New chat applies draft source rules before its first question — ${theme}`, async ({ page }) => {
    await open(page, theme);
    const settings = await enableSearchBeta(page);
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    const before = await page.evaluate(() => (window as unknown as Host).__kbFake.world.chats.length);
    const composer = page.getByTestId('composer');
    await composer.getByRole('button', { name: 'Search rules for this chat', exact: true }).click();
    const panel = composer.getByRole('dialog', { name: 'Search and sources for this chat' });
    await panel.getByRole('radio', { name: 'Only these', exact: true }).click();
    await panel.getByRole('button', { name: 'Add material' }).click();
    await panel.getByRole('textbox', { name: 'Find a material or wiki page' }).fill('Lecture 8');
    await panel.getByRole('button', { name: 'Lecture 8 — entropy', exact: true }).click();
    await panel.getByRole('switch', { name: 'Web · only these sites' }).click();
    const only = panel.getByRole('region', { name: 'Web · only these sites' });
    await only.getByRole('button', { name: 'Add site' }).click();
    await only.getByRole('textbox', { name: 'Add to only these sites' }).fill('example.org');
    await only.getByRole('textbox', { name: 'Add to only these sites' }).press('Enter');
    await page.screenshot({ path: path.join(shots, `new-chat-rules-${theme}.png`) });
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as Host).__kbFake.world.chats.length)).toBe(before);
    await composer.getByRole('textbox', { name: 'Message', exact: true }).fill('A controlled first question');
    await composer.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await expect.poll(() => page.evaluate(() => {
      const f = (window as unknown as Host).__kbFake;
      const id = f.services.chats.getState().currentId;
      return id ? f.world.chatSearchRules?.[id] : null;
    })).toMatchObject({ sources_only: true, sources: ['m1'], web: { only_on: true, only: ['example.org'] } });
    await expect(composer.getByRole('button', { name: 'Search rules for this chat: Only these · 2', exact: true })).toBeVisible();
  });

  test(`comparison drag cancels on Escape and blur without persisting or selecting — ${theme}`, async ({ page }) => {
    await open(page, theme);
    await answer(page, [compare]);
    const block = page.getByRole('region', { name: 'Comparison: Feedback table' });
    const handle = block.getByRole('separator', { name: 'Resize Controlled technique Alpha column', exact: true });
    await handle.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    const saved = await page.evaluate(() => localStorage.getItem('skaz.kb.compare-widths'));
    for (const how of ['escape', 'blur']) {
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 64, box.y + box.height / 2, { steps: 3 });
      await expect(handle).toHaveAttribute('aria-valuenow', '224');
      if (how === 'escape') await page.keyboard.press('Escape');
      else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.mouse.up();
      await expect(handle).toHaveAttribute('aria-valuenow', '160');
      expect(await page.evaluate(() => localStorage.getItem('skaz.kb.compare-widths'))).toBe(saved);
      await expect(block.locator('[data-selected="true"]')).toHaveCount(0);
    }
  });

  test(`comparison tolerates corrupt preferences and bounds saved layouts — ${theme}`, async ({ page }) => {
    await open(page, theme);
    await page.evaluate(() => localStorage.setItem('skaz.kb.compare-widths', '{not-json'));
    await answer(page, [compare]);
    const handle = page.getByRole('separator', { name: 'Resize Controlled technique Alpha column', exact: true });
    await handle.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '144');
    await page.evaluate(() => localStorage.setItem('skaz.kb.compare-widths', JSON.stringify(
      [...Array.from({ length: 250 }, (_, i) => [`stale-${i}`, [144, 160]]),
        ['oversized-columns', Array<number>(1000).fill(144)]])));
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('skaz.kb.compare-widths')!).length)).toBe(200);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('skaz.kb.compare-widths')!)
      .some(([id]: [string]) => id === 'oversized-columns'))).toBe(false);
    await expect(handle).toHaveAttribute('aria-valuenow', '160');
  });

  test(`table hover is local to the cell, not the entire row — ${theme}`, async ({ page }) => {
    await open(page, theme);
    await answer(page, [compare]);
    const block = page.getByRole('region', { name: 'Comparison: Feedback table' });
    const row = block.locator('tbody tr');
    const cell = row.locator('td').first();
    await expect(cell).toBeVisible();
    await cell.hover();
    await page.screenshot({ path: path.join(shots, `table-hover-${theme}.png`) });
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(cell).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await cell.click();
    await expect(cell).toHaveAttribute('data-selected', 'true');
    await expect(row).toHaveAttribute('data-selected', 'false');
    await block.getByRole('rowheader', { name: 'Characteristic', exact: true }).click();
    await expect(row).toHaveAttribute('data-selected', 'true');
  });

  test(`comparison reset reports the rendered width to keyboard users — ${theme}`, async ({ page }) => {
    await open(page, theme);
    await answer(page, [compare]);
    const block = page.getByRole('region', { name: 'Comparison: Feedback table' });
    const heading = block.getByRole('columnheader', { name: 'Controlled technique Alpha', exact: true });
    const handle = block.getByRole('separator', { name: 'Resize Controlled technique Alpha column', exact: true });
    await handle.focus();
    await page.keyboard.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '1200');
    await page.keyboard.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', '144');
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '160');
    await handle.dblclick();
    await expect.poll(async () => Math.abs(Number(await handle.getAttribute('aria-valuenow')) - (await heading.boundingBox())!.width)).toBeLessThan(1);
  });

  for (const width of [1440, 820]) test(`comparison columns resize without picking cells — ${theme} ${width}`, async ({ page }) => {
    await open(page, theme, width);
    await answer(page, [compare]);
    const block = page.getByRole('region', { name: 'Comparison: Feedback table' });
    const heading = block.getByRole('columnheader', { name: 'Controlled technique Alpha', exact: true });
    const handle = block.getByRole('separator', { name: 'Resize Controlled technique Alpha column', exact: true });
    await expect(handle).toBeVisible();
    const before = (await heading.boundingBox())!.width;
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await heading.boundingBox())!.width).toBeCloseTo(before + 16, 0);
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    const resized = (await heading.boundingBox())!.width;
    expect(resized).toBeCloseTo(before + 96, 0);
    await expect(block.locator('tbody [data-selected="true"]')).toHaveCount(0);
    const pageWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client);
    const wrap = block.locator('.kb-blk-cmp__wrap');
    expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await page.screenshot({ path: path.join(shots, `table-resized-${theme}-${width}.png`) });
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await answer(page, [compare]);
    await expect.poll(async () => (await heading.boundingBox())?.width).toBeCloseTo(resized, 0);
  });
}
