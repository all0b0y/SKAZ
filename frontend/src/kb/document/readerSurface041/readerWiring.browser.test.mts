import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { expect } from '@playwright/test';
import { chromium, type Browser, type Locator } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { contrast, over, parseColor } from '../../ui/color.ts';

const fixture = '/frontend/src/kb/document/readerSurface041/readerHost.fixture.html';
const artifacts = process.env.G2_BROWSER_ARTIFACTS;
const backdrops = [{ r: 0, g: 0, b: 0, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }];
let server: ViteDevServer;
let browser: Browser;
let origin: string;

before(async () => {
  if (artifacts) await mkdir(artifacts, { recursive: true });
  server = await createServer({
    configFile: false,
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

function color(value: string) {
  const parsed = parseColor(value);
  assert.ok(parsed, 'Unreadable computed colour: ' + value);
  return parsed;
}

async function surface(locator: Locator) {
  return locator.evaluate((el) => {
    const { backdropFilter, backgroundColor, boxShadow, opacity } = getComputedStyle(el);
    return { backdropFilter, backgroundColor, boxShadow, opacity };
  });
}

async function checkGlass(overlay: Locator, labels: Locator) {
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveCSS('opacity', '1');
  const styles = await surface(overlay);
  assert.equal(styles.backdropFilter, 'blur(12px)');
  assert.match(styles.boxShadow, /inset/);
  const background = color(styles.backgroundColor);
  assert.ok(background.a > 0.9 && background.a < 1);
  const inks = await labels.evaluateAll((elements) => elements.map((el) => getComputedStyle(el).color));
  assert.ok(inks.length > 0);
  const minimum = Math.min(...inks.flatMap((ink) => backdrops.map((bg) => contrast(color(ink), over(background, bg)))));
  assert.ok(minimum >= 4.5, minimum.toFixed(2) + ':1');
  return minimum;
}

async function checkHeaderActions(panel: Locator) {
  const header = panel.locator('header.kb-reader-header');
  const assertions = await header.evaluate((el) => {
    const { left, right, top, bottom, height } = el.getBoundingClientRect();
    const buttons = [...el.querySelectorAll('button')];
    const clipped = buttons.filter((button) => {
      const box = button.getBoundingClientRect();
      return !box.width || !box.height || box.left < left || box.right > right || box.top < top || box.bottom > bottom;
    });
    return { count: buttons.length, clipped: clipped.map((button) => button.getAttribute('aria-label')), height };
  });
  assert.deepEqual(assertions.clipped, []);
  return assertions;
}

async function checkViewportBounds(locator: Locator) {
  const { left, right, top, bottom, width, height, clientWidth, scrollWidth } = await locator.evaluate((el) => ({
    ...el.getBoundingClientRect().toJSON(),
    width: innerWidth,
    height: innerHeight,
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  assert.ok(left >= 0 && right <= width && top >= 0 && bottom <= height);
  assert.ok(scrollWidth <= clientWidth);
}

for (const theme of ['light', 'dark']) {
  for (const width of [768, 1040]) {
    test(theme + ' theme at ' + width + 'px uses opaque readers and legible glass in the live renderer', async (t) => {
      const page = await browser.newPage({ viewport: { width, height: 780 }, reducedMotion: 'reduce' });
      t.after(() => page.close());
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) await route.continue();
        else { errors.push('External request: ' + url.origin); await route.abort(); }
      });

      await page.goto(origin + fixture + '?theme=' + theme);
      await page.getByRole('button', { name: /Why is there a logarithm/ }).click();
      const chat = page.getByRole('region', { name: 'Chat' });
      const draft = chat.getByRole('textbox', { name: 'Message' });
      await draft.fill('Retain this draft');
      await page.getByRole('button', { name: 'Wiki', exact: true }).click();
      await page.getByRole('button', { name: /^Entropy(?:$| )/ }).first().click();

      const panel = page.getByRole('complementary', { name: 'Document' });
      await expect(panel.getByRole('heading', { name: 'Entropy', exact: true })).toBeVisible();
      await expect(panel).toHaveCSS('width', '320px');
      const chatHeader = chat.locator('.kb-head--chat');
      const readerHeader = panel.locator('.kb-reader-header');
      for (const base of [chatHeader, chat.locator('.kb-chat__workspace'), readerHeader, panel.locator('.kb-doc__body')]) {
        const styles = await surface(base);
        assert.equal(styles.backdropFilter, 'none');
        assert.equal(styles.opacity, '1');
        assert.equal(color(styles.backgroundColor).a, 1);
      }
      assert.match((await surface(chatHeader)).boxShadow, /inset/);
      assert.match((await surface(readerHeader)).boxShadow, /inset/);
      const composer = chat.getByTestId('composer');
      assert.match((await surface(composer)).boxShadow, /inset/);
      assert.equal(color((await surface(composer)).backgroundColor).a, 1);

      const terms = panel.getByRole('button', { name: 'What these labels mean' });
      await terms.press('Enter');
      const legend = page.getByRole('dialog', { name: 'What the wiki labels mean' });
      await expect(legend).toHaveCSS('opacity', '1');
      assert.equal((await surface(legend)).backdropFilter, 'none');
      assert.equal(color((await surface(legend)).backgroundColor).a, 1);
      await page.keyboard.press('Escape');
      await expect(terms).toBeFocused();

      const chatActions = chat.getByRole('button', { name: /^More for / });
      await chatActions.press('Enter');
      const chatMenu = page.getByRole('menu', { name: 'Chat actions' });
      const chatMenuContrast = await checkGlass(chatMenu, chatMenu.getByRole('menuitem'));
      await page.keyboard.press('Escape');
      await expect(chatActions).toBeFocused();

      const pageActions = panel.getByRole('button', { name: 'Page actions', exact: true });
      await pageActions.press('Enter');
      const menu = page.getByRole('menu', { name: 'Page actions' });
      const menuContrast = await checkGlass(menu, menu.getByRole('menuitem'));
      await checkViewportBounds(menu);
      await expect(menu.getByRole('menuitem', { name: 'Show the graph' })).toBeFocused();
      await page.keyboard.press('End');
      await expect(menu.getByRole('menuitem', { name: 'Delete page…' })).toBeFocused();
      if (artifacts) await page.screenshot({ path: resolve(artifacts, theme + '-' + width + '-menu.png') });
      await page.keyboard.press('Escape');
      await expect(pageActions).toBeFocused();

      const source = panel.getByRole('button', { name: 'Source 1: Lecture 8 — entropy' }).first();
      await source.click();
      const preview = page.getByRole('dialog', { name: 'Lecture 8 — entropy', exact: true });
      const quote = preview.getByRole('button', { name: 'Open at quote, 08:12' });
      const quoteContrast = await checkGlass(preview, preview.locator('.kb-srcpop__title, .kb-srcpop__meta, .kb-srcpop__quote, .kb-srcpop__open'));
      await checkViewportBounds(preview);
      await expect(quote).toBeFocused();
      if (artifacts) await page.screenshot({ path: resolve(artifacts, theme + '-' + width + '-citation.png') });
      await page.keyboard.press('Escape');
      await expect(source).toBeFocused();
      await source.click();
      await quote.click();

      await expect(panel.locator('mark.kb-quote')).toHaveText('S equals k times the log of W');
      await expect(panel).toHaveAttribute('data-state', 'open');
      const materialLayout = await checkHeaderActions(panel);
      assert.equal(materialLayout.count, 7);
      await panel.getByRole('button', { name: 'Open the notes' }).click();
      await expect(panel.getByRole('heading', { name: 'Notes: Lecture 8 — entropy' })).toBeVisible();
      const notesLayout = await checkHeaderActions(panel);
      assert.equal(notesLayout.count, 8);
      if (artifacts) await page.screenshot({ path: resolve(artifacts, theme + '-' + width + '-notes.png') });
      await panel.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(panel.locator('mark.kb-quote')).toHaveText('S equals k times the log of W');
      const expand = panel.getByRole('button', { name: 'Expand to the centre' });
      await expand.press('Enter');
      await expect(panel).toHaveAttribute('data-state', 'expanded');
      await expect(chat).toBeHidden();
      const collapse = panel.getByRole('button', { name: 'Back to side panel' });
      await expect(collapse).toBeFocused();
      await collapse.press('Enter');
      await expect(draft).toHaveText('Retain this draft');
      await expect(chat.getByTestId('composer')).toHaveCount(1);
      assert.deepEqual(errors, []);
      t.diagnostic('Page menu ' + menuContrast.toFixed(2) + ':1, chat menu ' + chatMenuContrast.toFixed(2) + ':1, quote ' + quoteContrast.toFixed(2) + ':1; '
        + '320px reader with ' + materialLayout.count + '/' + notesLayout.count + ' reachable actions '
        + 'at heights ' + materialLayout.height + '/' + notesLayout.height + 'px');
    });
  }
}
