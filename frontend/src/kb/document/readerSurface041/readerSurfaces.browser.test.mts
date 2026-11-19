import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { contrast, over, parseColor } from '../../ui/color.ts';

let browser: Browser;
let css: string[];

before(async () => {
  const styles = ['tokens', 'base', 'ui', 'shell', 'cite'].map((name) => `../../styles/${name}.css`);
  css = await Promise.all([...styles, './readerHeader.css', './readerOverlays.css']
    .map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  browser = await chromium.launch();
});

after(() => browser?.close());

async function mount(page: Page) {
  // The header slots and portaled class combinations used by the reader, Menu and SourceMarks.
  await page.setContent(`
    <!doctype html>
    <html data-kb-ui data-theme="light" data-density="spacious">
      <body>
        <aside class="kb-doc" style="width:320px">
          <header class="kb-head kb-reader-header">
            <button class="kb-iconbtn kb-iconbtn--md" aria-label="Back"></button>
            <span class="kb-reader-header__type">
              <span class="kb-reader-header__label">Document with a long type label</span>
            </span>
            <div class="kb-reader-header__actions">
              <button class="kb-btn kb-btn--sm">Read notes</button>
              <button class="kb-iconbtn kb-iconbtn--md" aria-label="Ask about page"></button>
              <button class="kb-iconbtn kb-iconbtn--md" aria-label="Expand to the centre"></button>
              <button class="kb-iconbtn kb-iconbtn--md" aria-label="Page actions"></button>
              <button class="kb-iconbtn kb-iconbtn--md" aria-label="Close document"></button>
            </div>
          </header>
          <div class="kb-doc__body">Reading surface</div>
        </aside>
        <div class="kb-center"><header class="kb-head">Chat header</header></div>
        <div id="menu" class="kb-popover kb-menu kb-reader-menu" role="menu" style="top:100px;right:8px">
          <div class="kb-menu__list">
            <button id="item" class="kb-menu__item" role="menuitem">
              <span class="kb-menu__label">Read the page again with its linked references</span>
              <span id="note" class="kb-menu__note">1 source</span>
            </button>
            <button id="danger" class="kb-menu__item is-danger" role="menuitem">Delete page…</button>
          </div>
        </div>
        <div id="preview" class="kb-popover kb-srcpop-wrap kb-reader-citation-preview" role="dialog" style="top:240px;right:8px">
          <div class="kb-srcpop">
            <div id="time" class="kb-srcpop__meta">08:12</div>
            <blockquote id="quote" class="kb-srcpop__quote">Both changes happen together.</blockquote>
            <button id="open" class="kb-srcpop__open">Open at quote</button>
          </div>
        </div>
        <div id="composer-menu" class="kb-popover kb-menu kb-agentmenu" role="menu"></div>
        <div id="dialog" class="kb-popover" role="dialog"></div>
      </body>
    </html>
  `);
  for (const content of css) await page.addStyleTag({ content });
}

const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };

function color(value: string) {
  const parsed = parseColor(value);
  assert.ok(parsed, `Unrecognised computed colour: ${value}`);
  return parsed;
}

test('only opted-in overlays use glass and their text keeps 4.5:1 contrast across themes and bases', async (t) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
  t.after(() => page.close());
  await mount(page);

  let minimumContrast = Infinity;
  for (const theme of ['light', 'dark']) {
    for (const base of ['milk', 'paper', 'slate', 'sand']) {
      await page.evaluate(({ theme, base }) => Object.assign(document.documentElement.dataset, { theme, base }), { theme, base });
      const styles = await page.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const surface = (selector: string) => {
          const { backgroundColor, backdropFilter, boxShadow } = style(selector);
          return { backgroundColor, backdropFilter, boxShadow };
        };
        return {
          menu: surface('#menu'),
          preview: surface('#preview'),
          menuText: ['#item', '#note', '#danger'].map((selector) => style(selector).color),
          previewText: ['#quote', '#time', '#open'].map((selector) => style(selector).color),
          other: ['.kb-reader-header', '.kb-doc', '.kb-doc__body', '.kb-center .kb-head', '#composer-menu', '#dialog']
            .map(surface),
        };
      });
      for (const [surface, text] of [[styles.menu, styles.menuText], [styles.preview, styles.previewText]] as const) {
        assert.equal(surface.backdropFilter, 'blur(12px)');
        assert.match(surface.boxShadow, /inset/);
        const background = color(surface.backgroundColor);
        assert.ok(background.a > 0.9 && background.a < 1);
        for (const foreground of text.map(color)) {
          for (const backdrop of [black, white]) {
            const ratio = contrast(foreground, over(background, backdrop));
            minimumContrast = Math.min(minimumContrast, ratio);
            assert.ok(ratio >= 4.5, `${theme}/${base}: contrast ${ratio.toFixed(2)} for ${JSON.stringify(foreground)}`);
          }
        }
      }
      assert.ok(styles.other.every((surface) => surface.backdropFilter === 'none'));
      assert.equal(color(styles.other[0]!.backgroundColor).a, 1, 'The reader header is opaque');
      assert.equal(color(styles.other[1]!.backgroundColor).a, 1, 'The reader pane is opaque');
      assert.equal(color(styles.other[4]!.backgroundColor).a, 1, 'The composer menu is opaque');
      assert.equal(color(styles.other[5]!.backgroundColor).a, 1, 'The ordinary dialog is opaque');
    }
  }
  t.diagnostic(`Minimum text contrast over the two backdrop extremes: ${minimumContrast.toFixed(2)}:1`);
});

test('destructive menu text keeps 4.5:1 contrast during activation', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await mount(page);
  const action = page.locator('#danger');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await action.hover();
    await page.mouse.down();
    const { color: text, backgroundColor } = await action.evaluate((el) => {
      const { color, backgroundColor } = getComputedStyle(el);
      return { color, backgroundColor };
    });
    await page.mouse.up();
    const ratio = contrast(color(text), color(backgroundColor));
    assert.ok(ratio >= 4.5, `Pressed destructive action in ${theme}: ${ratio.toFixed(2)}:1`);
  }
});

test('narrow layouts keep every reader and overlay action visible', async (t) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
  t.after(() => page.close());
  await mount(page);

  for (const width of [320, 220]) {
    await page.setViewportSize({ width: width + 20, height: 640 });
    const bounds = await page.evaluate((width) => {
      document.querySelector<HTMLElement>('.kb-doc')!.style.width = `${width}px`;
      const box = (el: Element) => el.getBoundingClientRect().toJSON() as DOMRect;
      return {
        header: box(document.querySelector('.kb-reader-header')!),
        buttons: Array.from(document.querySelectorAll('.kb-reader-header button'), box),
        overlays: Array.from(document.querySelectorAll('#menu, #preview'), (el) => ({
          box: box(el),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          buttons: Array.from(el.querySelectorAll('button'), box),
        })),
      };
    }, width);
    assert.equal(bounds.buttons.length, 6);
    for (const button of bounds.buttons) assertFits(button, bounds.header);
    if (width === 320) assert.equal(bounds.header.height, 46, 'The supported narrow pane keeps a single row');
    for (const overlay of bounds.overlays) {
      assert.ok(overlay.box.left >= 0 && overlay.box.right <= width + 20);
      assert.ok(overlay.scrollWidth <= overlay.clientWidth);
      for (const button of overlay.buttons) assertFits(button, overlay.box);
    }
  }
});

function assertFits(child: DOMRect, parent: DOMRect) {
  assert.ok(child.width > 0 && child.height > 0 && child.left >= parent.left && child.right <= parent.right
    && child.top >= parent.top && child.bottom <= parent.bottom, JSON.stringify({ child, parent }));
}

test('reduced transparency and forced colours disable the glass effect', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await mount(page);
  const session = await page.context().newCDPSession(page);

  for (const preference of [
    { name: 'prefers-reduced-transparency', value: 'reduce' },
    { name: 'forced-colors', value: 'active' },
  ]) {
    await session.send('Emulation.setEmulatedMedia', { features: [preference] });
    const styles = await page.locator('#menu, #preview').evaluateAll((elements) => elements.map((el) => {
      const { backdropFilter, backgroundColor } = getComputedStyle(el);
      return { backdropFilter, backgroundColor };
    }));
    for (const style of styles) {
      assert.equal(style.backdropFilter, 'none', preference.name);
      assert.equal(color(style.backgroundColor).a, 1, preference.name);
    }
  }
});
