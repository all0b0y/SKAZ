import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { auditPanes } from './paneAudit';

// Phase S in a real browser on the shared fake backend (frontend/src/kb/test/harness.tsx?world=study):
// the card stack in the chat (question, answer, grades), the test (checked choice, the agent's opinion,
// result), the block beside the chat with its placeholder and "Agent sees", and the deck page — at
// 1440 in light and dark, with real and reduced motion. Layout audit 0; console clean. Screenshots go
// to .runtime/shots/kb-s for the visual comparison with study-v1/v2/v3.

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
    await deck.getByRole('button', { name: /Show answer/ }).click();
    await expect(card).toHaveClass(/is-back/);
    // The real flip: rotateX on the card (0.42 s), the answer face upright after it.
    await page.waitForTimeout(500);
    const transform = await card.evaluate((el) => getComputedStyle(el).transform);
    expect(transform).not.toBe('none');
    await expect(deck.getByRole('button', { name: 'Good, next in 10m' })).toBeVisible();
    await check(`cards-answer-${theme}`);
    await deck.getByRole('button', { name: 'Good, next in 10m' }).click();
    await expect(deck.getByText('2 / 3')).toBeVisible();
  });

  test(`the block beside the chat: placeholder, Agent sees, Bring back — 1440 ${theme}`, async () => {
    await open(theme);
    await chats().getByRole('button', { name: /Lecture 8 — cards/ }).click();
    const deck = page.getByRole('region', { name: 'Flashcards: Lecture 8' });
    await deck.getByRole('button', { name: 'Open beside the chat' }).click();
    const panel = page.getByRole('complementary', { name: 'Flashcards and tests' });
    await expect(panel.getByRole('region', { name: 'Flashcards: Lecture 8' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Flashcards: Lecture 8' })).toContainText('Open in panel');
    await expect(page.getByRole('note', { name: /Agent sees: Flashcards, card 1 of 3/ })).toBeVisible();
    await check(`cards-beside-${theme}`);
    await page.getByRole('group', { name: 'Flashcards: Lecture 8' }).getByRole('button', { name: 'Bring back' }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole('region', { name: 'Flashcards: Lecture 8' })).toBeVisible();
  });

  test(`a test: checked choice, the agent's opinion, result — 1440 ${theme}`, async () => {
    await open(theme);
    await chats().getByRole('button', { name: /Lecture 8 — test/ }).click();
    const t = page.getByRole('region', { name: 'Test: Lecture 8 check' });
    await t.getByRole('radio', { name: 'S = k·W²' }).click();
    await t.getByRole('button', { name: 'Check' }).click();
    await expect(t.getByText('Not quite.')).toBeVisible();
    await check(`test-choice-${theme}`);
    await t.getByRole('button', { name: 'Next question' }).click();
    await t.getByRole('textbox', { name: 'Your answer' }).fill('W');
    await t.getByRole('button', { name: 'Check' }).click();
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
