import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { expect } from '@playwright/test';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let browser: Browser;
let origin: string;

before(async () => {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    cacheDir: resolve('.dev/vite-cache/live-panel-browser'),
    resolve: { alias: { '@': resolve('frontend/src') } },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  server.middlewares.use('/live-panel-fixture', (_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en">
      <head><title>SKAZ LivePanel fixture</title><link rel="icon" href="data:,"></head>
      <body><div id="root"></div>
      <script type="module" src="/frontend/src/kb/recording/livePanelHost.fixture.tsx"></script></body></html>`);
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

for (const theme of ['light', 'dark']) {
  test(theme + ': keyboard Retry reads the material and Continue resumes the same recording', async (t) => {
    const page = await browser.newPage({ viewport: { width: 768, height: 780 }, reducedMotion: 'reduce' });
    const errors: string[] = [];
    t.after(async () => {
      for (const error of errors) t.diagnostic(error);
      await page.close();
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) await route.continue();
      else { errors.push('External request: ' + url.origin); await route.abort(); }
    });
    const response = await page.goto(origin + '/live-panel-fixture?theme=' + theme);
    assert.equal(response?.status(), 200);
    const bar = page.getByTestId('titlebar');
    const record = bar.getByRole('button', { name: 'Record', exact: true });
    await expect(record).toBeEnabled();
    await record.press('Enter');
    const capsule = bar.getByRole('button', { name: /^Recording/ });
    await expect(capsule).toBeVisible();
    const panel = page.getByRole('complementary', { name: 'Live recording' });
    const readError = panel.getByRole('alert').filter({ hasText: 'Couldn’t open this recording.' });
    await expect(readError).toContainText('The recording could not be read.');
    const observed = () => page.evaluate(() => window.livePanelFixture.observed());
    const { id } = await observed();
    assert.ok(id);

    await page.evaluate(() => window.livePanelFixture.failRecognition());
    await expect(record).toBeVisible();
    await expect(panel.getByText('Recognition stopped at 00:42.')).toBeVisible();
    const close = panel.getByRole('button', { name: 'Close live transcript' });
    const retry = panel.getByRole('button', { name: 'Try again' });
    const resume = panel.getByRole('button', { name: 'Continue recording' });
    await expect(panel).toHaveCSS('width', '320px');
    await expect(retry).toBeInViewport({ ratio: 1 });
    await expect(resume).toBeInViewport({ ratio: 1 });
    assert.deepEqual(await observed(), { id, readPaths: ['/kb/materials/' + id], writes: ['/kb/recordings'], starts: 1 });
    await close.focus();
    await page.keyboard.press('Tab');
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await observed()).readPaths).toEqual(Array(2).fill('/kb/materials/' + id));
    await expect(readError).toBeVisible();
    assert.deepEqual((await observed()).writes, ['/kb/recordings']);

    await close.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(resume).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await observed()).starts).toBe(2);
    await expect(capsule).toBeVisible();
    const continued = await observed();
    assert.equal(continued.id, id);
    assert.deepEqual(continued.writes, ['/kb/recordings', '/kb/recordings/' + id + '/resume']);
    assert.deepEqual(errors, []);
  });
}

test('keeps final speech visible and retries a stopped recording read by keyboard', async (t) => {
  const page = await browser.newPage({ viewport: { width: 768, height: 780 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) await route.continue();
    else { errors.push('External request: ' + url.origin); await route.abort(); }
  });
  await page.goto(origin + '/live-panel-fixture?lateRead');
  const record = page.getByTestId('titlebar').getByRole('button', { name: 'Record', exact: true });
  await expect(record).toBeEnabled();
  await record.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Live recording' });
  await expect(panel.getByText('A sentence from material detail.')).toBeVisible();
  await page.evaluate(() => window.livePanelFixture.addFinalFragment());
  const final = panel.getByText('A final sentence from the live poll.');
  await expect(final).toBeVisible();
  await page.evaluate(() => window.livePanelFixture.failRecognition());
  await expect(panel.getByText('Couldn’t refresh the final transcript.')).toBeVisible();
  await expect(final).toBeVisible();
  const observed = () => page.evaluate(() => window.livePanelFixture.observed());
  const { id } = await observed();
  assert.ok(id);
  assert.deepEqual((await observed()).readPaths, Array(2).fill('/kb/materials/' + id));
  await page.evaluate(() => window.livePanelFixture.recoverRead());
  await panel.getByRole('button', { name: 'Close live transcript' }).focus();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('The authoritative final sentence.')).toHaveCount(1);
  await expect(final).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Continue recording' })).toBeEnabled();
  assert.deepEqual(await observed(), { id, readPaths: Array(3).fill('/kb/materials/' + id), writes: ['/kb/recordings'], starts: 1 });
  assert.deepEqual(errors, []);
});
