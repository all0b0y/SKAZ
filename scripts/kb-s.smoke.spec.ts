import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { auditPanes } from './paneAudit';

// Phase S in a real browser on the shared fake backend (frontend/src/kb/test/harness.tsx?world=study):
// the card stack in the chat (question, answer, grades), the test (checked choice, the agent's opinion,
// result), the block beside the chat with its placeholder and "Agent sees", and the deck page — at
// 1440 in light and dark, with real and reduced motion. Card A (STUDY-CARDS-SPEC): a 560 px 3:2 sheet in
// the chat, narrower beside it with nothing scrolling sideways or cut. Layout audit 0; console clean.
// Screenshots go to .runtime/shots/kb-s for the visual comparison with the mocks.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_S_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-s');
const THEMES = ['light', 'dark'] as const;

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

async function open(theme: 'light' | 'dark', reducedMotion: 'reduce' | 'no-preference' = 'reduce') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.goto(`${base}/src/kb/test/harness.html?world=study`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/src/kb/test/harness.html?world=study`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
}

async function check(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
  const panes = await page.evaluate(auditPanes);
  expect(panes, `${name}: pane violations ${JSON.stringify(panes, null, 1)}`).toEqual([]);
}

const chats = () => page.getByRole('region', { name: 'Chats' });

/** Nothing in the block reaches past its right edge, and the panel body doesn't scroll sideways. */
async function fitsBeside(block: ReturnType<Page['getByRole']>) {
  // Let the move into the panel finish (the block flies there): measure once its box stops changing.
  let last = '';
  for (let i = 0; i < 40; i += 1) {
    const now = JSON.stringify(await block.boundingBox());
    if (now === last) break;
    last = now;
    await page.waitForTimeout(80);
  }
  const report = await block.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const body = el.closest('.kb-st-panel__body') as HTMLElement | null;
    const out = [...el.querySelectorAll('*')].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
    }).map((n) => `${n.tagName}.${(n as HTMLElement).className}`);
    return { width: box.width, sideways: body ? body.scrollWidth - body.clientWidth : -1, out };
  });
  expect(report.out, 'elements past the block').toEqual([]);
  expect(report.sideways).toBeLessThanOrEqual(0);
  return report.width;
}

/** A face's text is all there: it fits, or the face scrolls to it (never clipped). */
async function notClipped(face: ReturnType<Page['locator']>) {
  const r = await face.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth,
    overflow: getComputedStyle(el).overflowY }));
  expect(r.sw).toBeLessThanOrEqual(r.cw);
  if (r.sh > r.ch) expect(r.overflow).toBe('auto');
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
  test(`cards in the chat: stack, flip up, grades with intervals — 1440 ${theme}`, async () => {
    await open(theme, 'no-preference');
    await chats().getByRole('button', { name: /Lecture 8 — cards/ }).click();
    const deck = page.getByRole('region', { name: 'Flashcards: Lecture 8' });
    await expect(deck.getByText('How did Boltzmann write entropy?')).toBeVisible();
    await check(`cards-question-${theme}`);
    // The stack: two cards peek out behind the current one, inside the block.
    const card = deck.locator('.kb-st-card');
    const scene = await deck.locator('.kb-st-scene').boundingBox();
    const box = await deck.boundingBox();
    expect(scene && box && scene.x >= box.x && scene.x + scene.width <= box.x + box.width).toBe(true);
    // Card A: 560 px wide, 3:2, centred in the block.
    const sheet = (await card.boundingBox())!;
    expect(Math.round(sheet.width)).toBe(560);
    expect(Math.abs(sheet.width / sheet.height - 1.5)).toBeLessThan(0.02);
    expect(Math.abs((sheet.x - box!.x) - (box!.x + box!.width - sheet.x - sheet.width))).toBeLessThan(2);
    await deck.getByRole('button', { name: /Show answer/ }).click();
    await expect(card).toHaveClass(/is-back/);
    // The real flip: rotateX on the card (0.42 s), the answer face upright after it.
    await page.waitForTimeout(500);
    const transform = await card.evaluate((el) => getComputedStyle(el).transform);
    expect(transform).not.toBe('none');
    await expect(deck.getByRole('button', { name: 'Good, next in 10m' })).toBeVisible();
    await notClipped(deck.locator('.kb-st-face--back'));
    await check(`cards-answer-${theme}`);
    await deck.getByRole('button', { name: 'Good, next in 10m' }).click();
    await expect(deck.getByText('2 / 3')).toBeVisible();
  });

  test(`the block beside the chat: placeholder, Agent sees, Bring back — 1440 ${theme}`, async () => {
    await open(theme);
    await chats().getByRole('button', { name: /Lecture 8 — cards/ }).click();
    const deck = page.getByRole('region', { name: 'Flashcards: Lecture 8' });
    await deck.getByRole('button', { name: 'Bigger — beside the chat' }).click();
    const panel = page.getByRole('complementary', { name: 'Flashcards and tests' });
    const beside = panel.getByRole('region', { name: 'Flashcards: Lecture 8' });
    await expect(beside).toBeVisible();
    await expect(page.getByRole('group', { name: 'Flashcards: Lecture 8' })).toContainText('Open beside the chat');
    await expect(page.getByRole('note', { name: /Agent sees: Flashcards, card 1 of 3/ })).toBeVisible();
    // One size button (⤡), no × of the panel's own.
    await expect(beside.locator('.kb-st-route').getByRole('button')).toHaveCount(1);
    await expect(beside.getByRole('button', { name: 'Smaller — back into the chat' })).toBeVisible();
    await expect(panel.getByRole('button', { name: /Close/ })).toHaveCount(0);
    const panelWidth = (await panel.boundingBox())!.width;
    expect(panelWidth).toBeGreaterThan(360);
    expect(panelWidth).toBeLessThan(480);
    expect(await fitsBeside(beside)).toBeLessThan(560);
    await check(`cards-beside-${theme}`);
    await beside.getByRole('button', { name: /Show answer/ }).click();
    await expect(beside.getByRole('button', { name: 'Good, next in 10m' })).toBeVisible();
    await notClipped(beside.locator('.kb-st-face--back'));
    await fitsBeside(beside);
    await check(`cards-beside-answer-${theme}`);
    await page.getByRole('group', { name: 'Flashcards: Lecture 8' }).getByRole('button', { name: 'Bring back' }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole('region', { name: 'Flashcards: Lecture 8' })).toBeVisible();
  });

  test(`a test beside the chat: A/B/C keys, checked, nothing sideways — 1440 ${theme}`, async () => {
    await open(theme);
    await chats().getByRole('button', { name: /Lecture 8 — test/ }).click();
    await page.getByRole('region', { name: 'Test: Lecture 8 check' }).getByRole('button', { name: 'Bigger — beside the chat' }).click();
    const panel = page.getByRole('complementary', { name: 'Flashcards and tests' });
    const t = panel.getByRole('region', { name: 'Test: Lecture 8 check' });
    await expect(t).toBeVisible();
    await expect(t.locator('.kb-st-key')).toHaveText(['A', 'B', 'C']);
    await t.focus();
    await page.keyboard.press('a');
    await expect(t.getByRole('radio', { name: 'S = k·W²' })).toHaveAttribute('aria-checked', 'true');
    await fitsBeside(t);
    await check(`test-beside-${theme}`);
    await t.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(t.getByText('Not quite.')).toBeVisible();
    await fitsBeside(t);
    await check(`test-beside-checked-${theme}`);
    await t.getByRole('button', { name: 'Smaller — back into the chat' }).click();
    await expect(panel).toBeHidden();
  });

  test(`a test: checked choice, the agent's opinion, result — 1440 ${theme}`, async () => {
    await open(theme);
    await chats().getByRole('button', { name: /Lecture 8 — test/ }).click();
    const t = page.getByRole('region', { name: 'Test: Lecture 8 check' });
    const sheet = (await t.locator('.kb-st-face--flat').boundingBox())!;
    expect(Math.round(sheet.width)).toBe(560);
    await t.getByRole('radio', { name: 'S = k·W²' }).click();
    await t.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(t.getByText('Not quite.')).toBeVisible();
    await check(`test-choice-${theme}`);
    await t.getByRole('button', { name: 'Next question' }).click();
    await t.getByRole('textbox', { name: 'Your answer' }).fill('W');
    await t.getByRole('button', { name: 'Check', exact: true }).click();
    await t.getByRole('button', { name: 'Next question' }).click();
    await t.getByRole('textbox', { name: 'Your answer' }).fill('Because joined systems add up.');
    await t.getByRole('button', { name: 'Ask the agent to check' }).click();
    await expect(t.getByText('Codex’s opinion · not a fact')).toBeVisible({ timeout: 10_000 });
    await check(`test-open-${theme}`);
    await t.getByRole('button', { name: 'See result' }).click();
    await expect(t.getByText('1.5 of 3')).toBeVisible();
    await check(`test-result-${theme}`);
  });

  test(`the deck page: groups, Study, marks — 1440 ${theme}`, async () => {
    await open(theme);
    await page.evaluate(() => (window as unknown as { __kbFake: { services: { ui: { getState: () => { openDocument: (t: object) => void } } } } })
      .__kbFake.services.ui.getState().openDocument({ type: 'page', id: 'p-deck' }));
    await expect(page.getByRole('list', { name: 'Cards by group' })).toBeVisible();
    await page.getByRole('row', { name: /What is a microstate/ }).hover();
    await check(`deck-page-${theme}`);
  });
}

test('console stayed clean', () => {
  expect(consoleErrors).toEqual([]);
});
