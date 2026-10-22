import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// Chat actions v1 (confirmed 2026-10-21) in a real browser on the shared fake backend
// (frontend/src/kb/test/harness.tsx): Copy · Edit · Resend under your own message, Edit in place,
// Resend at the end, and the full-size diagram viewer. Light and dark at 1440 and 820.
// Compare with .dev/ui-redesign/chat-actions/frames/{hover,editing,resent,diagram}-{dark,light}.png.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_CHAT_ACTIONS_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-chat-actions');
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [{ width: 1440, height: 900 }, { width: 820, height: 640 }] as const;
const Q1 = 'Расскажи мне про SIEM системы';
const Q2 = 'Нарисуй это вертикально, как по TOGAF';
const DIAGRAM = [
  'flowchart LR',
  '  U[Пользователи] --> W[Рабочие станции]',
  '  S[Серверы и БД] --> N[Сеть и МЭ]',
  '  W --> SIEM',
  '  N --> SIEM',
  '  SIEM --> SOC',
].join('\n');

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

/** The mock's conversation in chat c1: a question, an answer with a diagram, a model change, a second question and answer. */
async function seed() {
  await page.evaluate(({ q1, q2, diagram }) => {
    type W = { chats: Array<{ id: string; title: string; messages: unknown[]; cursor: number; model: string | null }> };
    const world = (window as unknown as { __kbFake: { world: W } }).__kbFake.world;
    const c1 = world.chats.find((c) => c.id === 'c1')!;
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const msg = (id: string, seq: number, role: string, text: string, extra: Record<string, unknown> = {}) => ({
      id, seq, role, created_at: at(10 - seq), engine: role === 'user' ? null : 'claude_code', model: role === 'assistant' ? 'claude-opus-5-5' : null,
      state: 'done', parts: [{ type: 'text', text }], failure: null, saved_page_id: null,
      input: role === 'user' ? { text, mentions: [], quotes: [], attachments: [] } : null, ...extra,
    });
    c1.title = q1;
    c1.messages = [
      msg('c1-u1', 1, 'user', q1),
      msg('c1-a1', 2, 'assistant', `SIEM — системы сбора и корреляции событий безопасности. Ниже упрощённая схема: источники событий отправляют журналы в SIEM, а она поднимает оповещения для SOC.\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`),
      msg('c1-s1', 3, 'system', 'Model changed to Claude Opus 5.5'),
      msg('c1-u2', 4, 'user', q2),
      msg('c1-a2', 5, 'assistant', 'Да. Ниже вертикальный эскиз с четырьмя архитектурными областями TOGAF…'),
    ];
    c1.cursor = 5;
  }, { q1: Q1, q2: Q2, diagram: DIAGRAM });
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
  const chat = page.getByRole('region', { name: 'Chat' });
  await expect(chat.getByRole('figure', { name: 'Diagram' }).locator('svg.pele')).toBeVisible();
  return chat;
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
    test(`your message actions, edit, diagram viewer, resend — ${size.width} ${theme}`, async () => {
      const tag = `${theme}-${size.width}`;
      const chat = await open(theme, size);
      const second = chat.getByRole('article', { name: 'Your question' }).nth(1);
      const row = second.getByRole('group', { name: 'Message actions' });
      // Hidden until the pointer is over the message.
      await page.mouse.move(5, 5);
      await expect.poll(() => row.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
      await second.locator('.kb-msg__bubble').hover();
      await expect.poll(() => row.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      await row.getByRole('button', { name: 'Copy' }).hover();
      await page.waitForTimeout(600); // the tooltip's delay
      await shot(`hover-${tag}`);

      // Edit in place: the field, the note, Cancel · Send.
      await row.getByRole('button', { name: 'Edit' }).click();
      const field = second.getByRole('textbox', { name: 'Edit your question' });
      await expect(field).toBeFocused();
      await page.keyboard.type(' и чем они отличаются от XDR');
      await expect(second).toContainText('Answers after this question are removed and it is answered again.');
      await shot(`editing-${tag}`);
      await page.keyboard.press('Escape');
      await expect(field).toHaveCount(0);
      await expect(second.locator('.kb-msg__bubble')).toHaveText(Q2);

      // The diagram at full size, zoomed in with ⌘+wheel around the pointer.
      const figure = chat.getByRole('figure', { name: 'Diagram' });
      const expand = figure.getByRole('button', { name: 'Open full size' });
      await expect(expand).toBeVisible();
      await expand.click();
      const viewer = page.getByRole('dialog', { name: 'Diagram' });
      await expect(viewer).toBeVisible();
      await expect(viewer).toContainText('⌘ + scroll or pinch to zoom · drag to move · Esc to close');
      const canvas = viewer.locator('.kb-dviewer__canvas');
      const box = (await canvas.boundingBox())!;
      const fit = Number((await viewer.getByRole('status', { name: 'Zoom' }).textContent())!.replace('%', ''));
      await page.waitForTimeout(600); // the window's fade-in
      await shot(`diagram-open-${tag}`);
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      await page.keyboard.down('Meta');
      for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -100);
      await page.keyboard.up('Meta');
      await expect.poll(async () => Number((await viewer.getByRole('status', { name: 'Zoom' }).textContent())!.replace('%', ''))).toBeGreaterThan(fit);
      const sharp = await viewer.locator('.kb-dviewer__drawing > svg').evaluate((svg) => ({
        width: Number(svg.getAttribute('width')), box: (svg as SVGSVGElement).viewBox.baseVal.width, transform: getComputedStyle(svg).transform,
      }));
      expect(sharp.width).toBeGreaterThan(sharp.box);
      expect(sharp.transform).toBe('none');
      await shot(`diagram-${tag}`);
      await page.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);
      await expect(expand).toBeFocused();

      // Resend: the same question again at the end; the answer is being written (held).
      await second.locator('.kb-msg__bubble').hover();
      await row.getByRole('button', { name: 'Resend' }).click();
      await expect(chat.getByRole('article', { name: 'Your question' })).toHaveCount(3);
      await expect(chat.getByRole('article', { name: 'Your question' }).nth(2)).toContainText(Q2);
      await expect(chat.getByText('Writing an answer…')).toBeVisible();
      await page.mouse.move(5, 5);
      await chat.locator('.kb-chat__scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await shot(`resent-${tag}`);
      expect(consoleErrors, 'console errors').toEqual([]);
    });
  }
}

test('Edit → Send replaces the question and the replies after it — 1440 light', async () => {
  const chat = await open('light', { width: 1440, height: 900 });
  const first = chat.getByRole('article', { name: 'Your question' }).first();
  await first.locator('.kb-msg__bubble').hover();
  await first.getByRole('group', { name: 'Message actions' }).getByRole('button', { name: 'Edit' }).click();
  await page.keyboard.type(' коротко');
  await page.keyboard.press('Enter');
  await expect(chat.getByRole('article', { name: 'Your question' })).toHaveCount(1);
  await expect(chat.getByRole('article', { name: 'Your question' })).toContainText(`${Q1} коротко`);
  await expect(chat.getByRole('figure', { name: 'Diagram' })).toHaveCount(0);
  await expect(chat.getByText('Model changed to Claude Opus 5.5')).toHaveCount(0);
  await expect(chat.getByText('Writing an answer…')).toBeVisible();
  await shot('edit-sent-light-1440');
  expect(consoleErrors, 'console errors').toEqual([]);
});
