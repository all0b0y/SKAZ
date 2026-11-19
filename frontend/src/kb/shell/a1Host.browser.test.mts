import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { expect } from '@playwright/test';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const fixture = '/frontend/src/kb/document/readerSurface041/readerHost.fixture.html';
const clear = 'rgba(0, 0, 0, 0)';
let server: ViteDevServer;
let browser: Browser;
let origin: string;

before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    cacheDir: resolve('.dev/vite-cache/a1-host'),
    resolve: { alias: { '@': resolve('frontend/src') } },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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

async function openHost(t: TestContext, theme: 'light' | 'dark', width: number) {
  const page = await browser.newPage({
    viewport: { width, height: 780 }, reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const errors: string[] = [];
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) await route.continue();
    else {
      errors.push('External request: ' + url.origin);
      await route.abort();
    }
  });
  await page.goto(origin + fixture + '?theme=' + theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  return page;
}

for (const theme of ['light', 'dark'] as const) {
  for (const fullScreen of [false, true]) {
    test(`${theme} title toggle uses the hover tint and outline on keyboard focus (fullscreen CSS: ${fullScreen})`, async (t) => {
      const page = await openHost(t, theme, 1040);
      if (fullScreen) {
        await page.evaluate(() => { document.documentElement.dataset.fullScreen = ''; });
      }
      const bar = page.getByTestId('titlebar');
      await expect(bar).toHaveCSS('padding-left', fullScreen ? '12px' : '80px');
      const hide = bar.getByRole('button', { name: 'Hide side panel' });
      const show = bar.getByRole('button', { name: 'Show side panel' });
      await expect(hide).toHaveCSS('background-color', clear);
      await hide.hover();
      await expect(hide).not.toHaveCSS('background-color', clear);
      await expect(page.getByRole('tooltip', { name: 'Hide side panel' })).toBeVisible();
      const hover = await hide.evaluate((el) => {
        const { backgroundColor, color } = getComputedStyle(el);
        return { backgroundColor, color };
      });
      await page.mouse.move(0, 0);
      await expect(hide).toHaveCSS('background-color', clear);

      await page.keyboard.press('Tab');
      await expect(hide).toBeFocused();
      await expect(hide).toHaveCSS('outline-style', 'solid');
      await expect(hide).toHaveCSS('outline-width', '2px');
      await expect(hide).toHaveCSS('background-color', hover.backgroundColor);
      await expect(hide).toHaveCSS('color', hover.color);
      await page.keyboard.press('Enter');
      await expect(show).toBeFocused();
      await expect(show).toHaveCSS('background-color', hover.backgroundColor);
      await expect(page.getByRole('tooltip', { name: 'Show side panel' })).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(show).toHaveCSS('background-color', clear);
    });
  }
}

for (const width of [768, 1040]) {
  test(`Check links and Write notes fit the material reader at ${width}px`, async (t) => {
    const page = await openHost(t, 'light', width);
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Materials' }).click({ timeout: 5000 });
    await page.getByTestId('all-materials').click({ timeout: 5000 });
    const grid = page.getByRole('region', { name: 'All materials' }).getByRole('grid');
    await grid.getByRole('button', { name: 'Cross-entropy explained' }).click({ timeout: 5000 });
    const panel = page.getByRole('complementary', { name: 'Document' });
    await expect(panel).toHaveCSS('width', '320px');
    const row = panel.locator('.kb-mat__actions').filter({ has: page.getByRole('button', { name: 'Check links' }) });
    await expect(row.getByRole('button')).toHaveText(['Write notes', 'Check links']);
    await expect(panel.getByTestId('freshness')).toHaveCount(0);
    const bounds = await panel.boundingBox();
    assert.ok(bounds);
    for (const button of await row.getByRole('button').all()) {
      const rect = await button.boundingBox();
      assert.ok(rect && rect.width > 0 && rect.height > 0);
      assert.ok(rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width);
      await button.click({ trial: true });
    }
  });
}
