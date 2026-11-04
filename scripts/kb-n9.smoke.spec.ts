import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import type { KbInstallTask, KbWebSearchPart } from '../frontend/src/api/kb/types.gen';
import type { createServices } from '../frontend/src/kb/state/context';
import type { FakeWorld } from '../frontend/src/kb/test/fakeKb';

// The real renderer/CSS/Canvas in Chromium; authored API-boundary fixtures only.
// No real profile, installer, microphone, sign-in, provider or external network access.
type Harness = { world: FakeWorld; services: ReturnType<typeof createServices> };
type Host = Window & { __kbFake: Harness; __n9Calls: Array<{ method: string; path: string }> };
const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_N9_SHOTS ?? path.join(root, '.runtime/shots/kb-n9');
const sizes = [{ width: 1440, height: 900 }, { width: 1024, height: 760 }, { width: 820, height: 640 }];
let server: ViteDevServer;
let base = '';

test.describe.configure({ mode: 'serial' });
test.use({ deviceScaleFactor: 2 });
test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  server = await createServer({ configFile: false, root: path.join(root, 'frontend'), plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'frontend/src') } },
    server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address !== 'object') throw new Error('No fixture server address');
  base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

async function open(page: Page, theme: 'light' | 'dark', motion: 'full' | 'calm' | 'off', reduced = false) {
  await page.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.emulateMedia({ colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      this.canvas.dataset.n9Paints = String(Number(this.canvas.dataset.n9Paints ?? 0) + 1);
      return clear.apply(this, args);
    };
  });
  await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await page.evaluate(({ theme, motion }) => {
    const host = window as unknown as Host;
    const f = host.__kbFake;
    f.services.prefs.getState().set({ theme, motion });
    Object.assign(f.world.agents.agents.find((a) => a.id === 'hermes')!, {
      installed: false, signed_in: false, state: 'not_installed', action: 'install', version: null,
    });
    const request = f.services.bridge.request;
    host.__n9Calls = [];
    f.services.bridge.request = (async (req) => {
      host.__n9Calls.push({ method: req.method, path: req.path });
      const reply = await request(req);
      if (reply.ok && req.method === 'POST' && req.path === '/kb/agents/hermes/install') {
        const task = reply.data as KbInstallTask;
        task.stages = [{ label: 'Run the official installer', state: 'running' }, { label: 'Check Hermes Agent', state: 'pending' }];
        task.lines[0]!.text = 'Running the official installer…';
        f.world.installTasks[task.id]!.stages = task.stages;
        f.world.installTasks[task.id]!.lines = task.lines;
      }
      return reply;
    }) as typeof request;
  }, { theme, motion });
  await expect(page.locator('html')).toHaveAttribute('data-motion', motion);
  await page.evaluate(async () => { await (window as unknown as Host).__kbFake.services.agents.getState().refresh(); });
}

async function web(page: Page) {
  await page.evaluate(async () => {
    const f = (window as unknown as Host).__kbFake;
    const chat = f.world.chats.find((c) => c.id === 'c1')!;
    const part: KbWebSearchPart = {
      type: 'web_search', id: 'n9-search', engine: 'claude_code', searcher: null, call_id: 'n9-native',
      query: 'Controlled search query', allowed_domains: [], blocked_domains: [], status: 'allowed', auto: false,
      reason: null, links: [], execution: 'running', started_at: new Date(Date.now() - 1200).toISOString(),
      duration_ms: null, execution_error: null,
    };
    chat.title = 'N9 renderer check'; chat.engine = 'claude_code';
    chat.messages = [{ id: 'n9-answer', seq: 1, role: 'assistant', engine: 'claude_code', model: null,
      state: 'streaming', failure: null, saved_page_id: null, input: null, created_at: new Date().toISOString(),
      parts: [{ type: 'tool', name: 'WebSearch', label: 'Searching the web', call_id: 'n9-native',
        status: 'running', started_at: part.started_at, duration_ms: null }, part] }];
    chat.cursor = 1;
    await f.services.chats.getState().open('c1');
  });
  const card = page.getByRole('group', { name: 'Searching the web…: Controlled search query' });
  await expect(card).toBeVisible();
  return card;
}

async function outcome(page: Page, state: 'done' | 'error' | 'stopped' | 'unknown') {
  await page.evaluate((state) => {
    const f = (window as unknown as Host).__kbFake;
    const part = f.world.chats.find((c) => c.id === 'c1')!.messages[0]!.parts.find((p) => p.type === 'web_search')!;
    if (part.type !== 'web_search') throw new Error('Missing fixture search');
    part.execution = state;
    part.duration_ms = state === 'unknown' ? null : 640;
    part.execution_error = state === 'error' ? 'Web search could not be completed. Check the search agent and try again.' : null;
    f.services.chats.getState().applyPart('c1', part);
  }, state);
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

for (const theme of ['light', 'dark'] as const) for (const motion of ['full', 'calm', 'off'] as const) for (const size of sizes) {
  test(`N9 execution and installation — ${theme} ${motion} ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await open(page, theme, motion);
    const card = await web(page);
    const canvas = card.locator('[data-stipple-globe] canvas');
    const before = Number(await canvas.getAttribute('data-n9-paints'));
    if (motion !== 'off') await expect.poll(async () => Number(await canvas.getAttribute('data-n9-paints'))).toBeGreaterThan(before + 1);
    else { await page.waitForTimeout(150); expect(Number(await canvas.getAttribute('data-n9-paints'))).toBe(before); }
    const tag = `${theme}-${motion}-${size.width}`;
    await capture(page, `searching-${tag}`);
    await outcome(page, 'done');
    const done = page.getByRole('group', { name: 'Searched the web: Controlled search query' });
    await expect(done).toContainText('0 links');
    await expect(done.locator('.kb-web__completion')).toHaveText('Done');
    await expect(done.locator('[data-stipple-globe]')).toHaveAttribute('data-completion', 'still', { timeout: 2500 });
    const finishedCanvas = done.locator('canvas');
    const stopped = await finishedCanvas.getAttribute('data-n9-paints');
    await page.waitForTimeout(150);
    await expect(finishedCanvas).toHaveAttribute('data-n9-paints', stopped!);
    for (const [state, label] of [['error', 'Search failed'], ['stopped', 'Search stopped'], ['unknown', 'Search result unknown']] as const) {
      await outcome(page, state);
      const terminal = page.getByRole('group', { name: `${label}: Controlled search query` });
      await expect(terminal).toBeVisible();
      await expect(terminal.locator('[data-stipple-globe]')).toHaveCount(0);
      await expect(terminal.locator('.kb-web__completion')).toHaveCount(0);
    }
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: /^Accounts & keys/ }).click();
    const row = settings.getByRole('group', { name: 'Hermes Agent', exact: true });
    await row.getByRole('button', { name: 'Install', exact: true }).click();
    const progress = page.getByRole('dialog', { name: 'Install Hermes Agent', exact: true });
    await expect(progress.getByRole('status')).toContainText('Run the official installer');
    await expect(progress.getByRole('list', { name: 'Installation steps' }).locator('li')).toHaveCount(2);
    await expect(progress.getByRole('progressbar')).toHaveCount(0);
    await expect(progress.getByLabel('Install log')).toHaveCount(0);
    await capture(page, `installing-${tag}`);
    await progress.getByRole('button', { name: 'Run in background' }).click();
    await expect(progress).toHaveCount(0);
    await row.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(progress).toBeVisible();
    const command = "'/Users/me/Local Tools/installer' --check 'a path with spaces'";
    await page.evaluate((command) => {
      const f = (window as unknown as Host).__kbFake;
      const id = f.services.agents.getState().installs.hermes!.task.id;
      const task = f.world.installTasks[id]!;
      task.state = 'failed'; task.reason = 'The controlled installer did not finish.'; task.manual_command = command;
      task.stages![0]!.state = 'error';
      f.services.agents.getState().followInstall('hermes', id)();
      f.services.agents.getState().followInstall('hermes', id);
    }, command);
    await expect(progress.getByRole('status')).toHaveText('Failed');
    await expect(progress.getByRole('alert')).toContainText('The controlled installer did not finish.');
    await expect(progress.locator('code')).toHaveText(command);
    await expect(progress.locator('[data-stipple-globe]')).toHaveCount(0);
    await progress.getByRole('button', { name: 'Show output' }).click();
    await expect(progress.getByLabel('Install log')).toContainText('Running the official installer');
    const logBox = await progress.getByLabel('Install log').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(logBox.scroll).toBeLessThanOrEqual(logBox.client + 1); // one line must not collapse vertically
    const width = await progress.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
    const bounds = await progress.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height + 1);
    await capture(page, `failed-${tag}`);
    await progress.getByRole('button', { name: 'Try again' }).click();
    await expect(progress.getByRole('status')).toContainText('Run the official installer');
    await progress.getByRole('button', { name: 'Cancel installation' }).click();
    await expect(progress.getByRole('status')).toHaveText('Cancelled');
    const calls = await page.evaluate(() => (window as unknown as Host).__n9Calls);
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/kb/agents/hermes/install')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cancel'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test('system reduced motion keeps a static running globe even with the full knob', async ({ page }) => {
  await open(page, 'dark', 'full', true);
  const card = await web(page);
  const canvas = card.locator('canvas');
  const before = await canvas.getAttribute('data-n9-paints');
  await page.waitForTimeout(200);
  await expect(canvas).toHaveAttribute('data-n9-paints', before!);
  await outcome(page, 'done');
  await expect(page.locator('[data-stipple-globe]')).toHaveAttribute('data-completion', 'still');
});

test('a static running indicator immediately rereads changed accent and base colors', async ({ page }) => {
  await open(page, 'light', 'off');
  const card = await web(page);
  const canvas = card.locator('canvas');
  const before = Number(await canvas.getAttribute('data-n9-paints'));
  const imageBefore = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
  await page.evaluate(() => (window as unknown as Host).__kbFake.services.prefs.getState().set({ accent: 'petrol' }));
  await expect.poll(async () => Number(await canvas.getAttribute('data-n9-paints'))).toBeGreaterThan(before);
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).not.toBe(imageBefore);
  const after = Number(await canvas.getAttribute('data-n9-paints'));
  await page.evaluate(() => (window as unknown as Host).__kbFake.services.prefs.getState().set({ base: 'slate' }));
  await expect.poll(async () => Number(await canvas.getAttribute('data-n9-paints'))).toBeGreaterThan(after);
});
