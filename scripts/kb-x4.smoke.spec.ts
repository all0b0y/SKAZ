import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { auditPanes } from './paneAudit';

// X4 in a real browser on the shared fake backend (frontend/src/kb/test/harness.tsx, as kb-u2):
// quick questions over the message field while a recording runs (v39 rec), and a long paste that
// becomes a "Pasted text" card with its preview. 1440, light and dark; layout audit 0; console clean.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_X4_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-x4');
const THEMES = ['light', 'dark'] as const;

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

type Fake = {
  world: { chats: Array<{ id: string; state: string }> };
  services: {
    recording: { setState: (s: Record<string, unknown>) => void };
    ui: { getState: () => { openLive: (id: string) => void } };
  };
};

async function open(theme: 'light' | 'dark') {
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${base}/src/kb/test/harness.html`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/src/kb/test/harness.html`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
}

async function check(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
  const panes = await page.evaluate(auditPanes);
  expect(panes, `${name}: pane violations ${JSON.stringify(panes, null, 1)}`).toEqual([]);
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
  test(`quick questions over the field while recording — 1440 ${theme}`, async () => {
    await open(theme);
    // The recording's own chat, idle, with the live panel on the right (as Record leaves it).
    await page.evaluate(() => {
      const fake = (window as unknown as { __kbFake: Fake }).__kbFake;
      fake.world.chats.find((c) => c.id === 'c2')!.state = 'idle';
    });
    await page.getByRole('region', { name: 'Chats' }).getByRole('button', { name: /What did I miss in lecture 8/ }).click();
    const group = page.getByRole('group', { name: 'Quick questions about the recording' });
    await expect(group).toHaveCount(0);
    await page.evaluate(() => {
      const fake = (window as unknown as { __kbFake: Fake }).__kbFake;
      fake.services.recording.setState({ phase: 'recording', materialId: 'm1', title: 'Lecture 8 — entropy', elapsedMs: 761_000 });
      fake.services.ui.getState().openLive('m1');
    });
    await expect(group).toBeVisible();
    await expect(group.getByRole('button')).toHaveText(['What did I miss?', 'Explain a term', 'Summary so far']);
    await expect(page.getByRole('complementary', { name: 'Live recording' })).toBeVisible();
    // Above the field, never overlapping it.
    const chips = await group.boundingBox();
    const field = await page.getByTestId('composer').boundingBox();
    expect(chips!.y + chips!.height).toBeLessThanOrEqual(field!.y);
    await group.getByRole('button', { name: 'What did I miss?' }).click();
    await expect(page.getByRole('log', { name: 'Conversation' }).getByText('What did I miss?', { exact: true })).toBeVisible();
    await page.mouse.move(2, 300);
    await check(`rec-chips-1440-${theme}`);
  });

  test(`a long paste becomes a "Pasted text" card with a preview — 1440 ${theme}`, async () => {
    await open(theme);
    await page.getByRole('region', { name: 'Chats' }).getByRole('button', { name: /Why is there a logarithm/ }).click();
    const input = page.getByTestId('message-input');
    await input.click();
    const text = Array.from({ length: 60 }, (_, i) => `${i + 1}. Entropy notes: Boltzmann wrote S = k·ln W; Shannon took the same form for messages.`).join('\n');
    await page.evaluate((value) => {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      document.querySelector('[data-testid="message-input"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    const chips = page.getByRole('list', { name: 'Attachments' });
    const size = text.length.toLocaleString('en-US');
    await expect(chips.getByRole('button', { name: `Show the pasted text (${size} characters)` })).toHaveText(`Pasted text · ${size} characters`);
    await expect(input).toHaveText('');
    await page.keyboard.type('Summarise these notes');
    await page.mouse.move(2, 300);
    await check(`pasted-card-1440-${theme}`);
    await chips.getByRole('button', { name: `Show the pasted text (${size} characters)` }).click();
    const preview = page.getByRole('dialog', { name: 'Pasted text' });
    await expect(preview.getByRole('region', { name: 'Pasted text content' })).toContainText('60. Entropy notes');
    await check(`pasted-preview-1440-${theme}`);
  });
}

test('console stayed clean', () => {
  expect(consoleErrors).toEqual([]);
});
