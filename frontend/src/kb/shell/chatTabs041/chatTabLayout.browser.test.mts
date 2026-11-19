import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Locator } from 'playwright';
import { expect } from '@playwright/test';

async function isWithinTrack(tab: Locator) {
  return tab.evaluate((el) => {
    const item = el.parentElement!.getBoundingClientRect();
    const track = el.closest('[role="tablist"]')!.getBoundingClientRect();
    return item.left >= track.left - 1 && item.right <= track.right + 1;
  });
}

test('background updates preserve horizontal browsing, explicit selection and focus reveal the tab', async (t) => {
  const bundle = await build({
    entryPoints: ['frontend/src/kb/shell/chatTabs041/chatTabLayout.fixture.tsx'],
    outfile: 'fixture.js', format: 'iife', globalName: 'fixture', bundle: true, write: false, jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wav': 'dataurl' }, define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://fixture.invalid') {
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html data-kb-ui><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>' });
      const file = bundle.outputFiles.find((f) => f.path.endsWith(url.pathname));
      if (file) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: file.text });
    }
    errors.push(route.request().url());
    await route.abort();
  });
  await page.goto('http://fixture.invalid');
  assert.deepEqual(errors, []);
  const track = page.getByRole('tablist', { name: 'Open chats' });
  const last = track.getByRole('tab', { name: /Conversation 13/ });
  const first = track.getByRole('tab', { name: /^Conversation 0\b/ });
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Open tabs' })).toBeVisible();
  const geometry = await track.evaluate((el) => ({ width: el.clientWidth, total: el.scrollWidth }));
  assert.ok(geometry.total > geometry.width * 2);
  await expect.poll(() => isWithinTrack(last)).toBe(true);
  await track.hover();
  await page.mouse.wheel(-geometry.total, 0);
  await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBe(0);
  assert.equal(await isWithinTrack(last), false);
  await page.evaluate(() => (window as unknown as { fixture: { deliverUpdate(): void } }).fixture.deliverUpdate());
  await expect(page.getByRole('log')).toContainText('Measured delta', { timeout: 7500 });
  await expect(track.getByRole('tab', { name: /^Conversation 1\b/ }).getByLabel('New answer')).toBeAttached();
  const left = await track.evaluate((el) => el.scrollLeft);
  assert.equal(left, 0, 'horizontal scroll after detail and list delivery');
  await page.getByRole('button', { name: 'Open tabs' }).click();
  await page.getByRole('menuitem', { name: /^Conversation 13\b/ }).click();
  await expect(last).toBeFocused();
  assert.ok(await isWithinTrack(last));
  await last.press('Home');
  await expect(first).toBeFocused();
  assert.ok(await isWithinTrack(first));
  await first.press('End');
  await expect(last).toBeFocused();
  assert.ok(await isWithinTrack(last));
  await page.getByRole('button', { name: 'Open tabs' }).click();
  await page.getByRole('menuitem', { name: /^Conversation 0\b/ }).click();
  await expect(first).toBeFocused();
  assert.ok(await isWithinTrack(first));
  t.diagnostic(JSON.stringify({ ...geometry, afterUpdates: left }));
  assert.deepEqual(errors, []);
});
