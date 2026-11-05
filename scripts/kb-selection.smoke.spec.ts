import { expect, test, chromium, type Browser, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import type { KbServices } from '../frontend/src/kb/state/context';

// The real renderer/CSS and real Chromium pointer/HTML DnD over the established offline bridge.
// No microphone, provider or user profile is involved. Model quality is not under test.
const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_SELECTION_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-selection');
interface Harness {
  __kbFake: { services: KbServices; world: { materials: Array<{ id: string; folder_id: string }> } };
  __selectionScale: string[];
  __selectionDrags: string[];
  __selectionNative: Array<{ type: string; time: number; prevented: boolean; phase: string | null }>;
}
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({}, info) => {
  info.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  server = await createServer({ configFile: false, root: path.join(root, 'frontend'), plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'frontend/src') } },
    server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer!.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  browser = await chromium.launch();
  page = await browser.newPage({ deviceScaleFactor: 2 });
  page.setDefaultTimeout(5_000);
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    const scale: string[] = [], drags: string[] = [];
    const native: Harness['__selectionNative'] = [];
    Object.assign(window, { __selectionScale: scale, __selectionDrags: drags, __selectionNative: native });
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dragstart', 'dragover', 'drop', 'dragend']) {
      document.addEventListener(type, (event) => {
        const entry = { type, time: performance.now(), prevented: event.defaultPrevented,
          phase: document.querySelector('.kb-selection-hold')?.getAttribute('data-phase') ?? null };
        native.push(entry);
        queueMicrotask(() => { entry.prevented = event.defaultPrevented; });
      }, true);
    }
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      if (this.matches('[data-sel-id]') && Array.isArray(args[0])
        && args[0].some((frame) => frame.transform === 'scale(1.025)')) scale.push(this.getAttribute('data-sel-id')!);
      return original.apply(this, args);
    };
    document.addEventListener('dragstart', (event) => {
      const payload = event.dataTransfer?.getData('application/x-skaz-items');
      if (payload) drags.push(payload);
    });
  });
});
test.afterAll(async () => { await browser?.close(); await server?.close(); });

async function snapshot(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(shots, `${name}.png`), animations: 'disabled' });
}

/** Bound boxes before the press: no locator/actionability waits can turn an early drag into a hold. */
async function earlyNativeDrag(source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const start = await source.boundingBox(), end = await target.boundingBox();
  if (!start || !end) throw new Error('Native drag endpoints are not visible');
  await page.evaluate(() => { (window as unknown as Harness).__selectionNative.length = 0; });
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 2 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
  await page.mouse.up();
  const events = await page.evaluate(() => (window as unknown as Harness).__selectionNative);
  const traceFile = path.join(shots, `native-events-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(traceFile, JSON.stringify({ test: test.info().title, start, end, events }, null, 2));
  await test.info().attach('native-drag-events', { path: traceFile, contentType: 'application/json' });
  const down = events.find((e) => e.type === 'pointerdown');
  const drag = events.find((e) => e.type === 'dragstart');
  expect(down).toBeDefined();
  expect(drag).toBeDefined();
  expect(drag!.time - down!.time).toBeLessThan(350);
  expect(drag!.prevented).toBe(false);
  expect(events.some((e) => e.type === 'drop')).toBe(true);
}

test('native material drag timing stays below the hold threshold — repeated dark 820 off', async () => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 820, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  for (let attempt = 0; attempt < 24; attempt++) {
    await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await page.evaluate(() => {
      const { services } = (window as unknown as Harness).__kbFake;
      services.prefs.getState().set({ theme: 'dark', motion: 'off', section: 'materials' });
    });
    const materials = page.getByRole('region', { name: 'Materials', exact: true });
    const source = materials.locator('[data-sel-id="m3"]');
    const folder = materials.getByRole('list', { name: 'Folders' }).getByRole('button', { name: /^Physics/ });
    await expect(source).toBeVisible();
    await earlyNativeDrag(source, folder);
    await expect.poll(() => page.evaluate(() => (window as unknown as Harness).__kbFake.world.materials.find((m) => m.id === 'm3')?.folder_id)).toBe('phys');
  }
});

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1024, 820]) {
  for (const motion of ['full', 'calm', 'off'] as const) {
    test(`selection gestures — ${theme} ${width} ${motion}`, async () => {
      const firstError = errors.length;
      const tag = `${theme}-${width}-${motion}`;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
      await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${base}/src/kb/test/harness.html?hold=1`);
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as Harness).__kbFake.world.materials.map((m) => m.id)))
        .toEqual(expect.arrayContaining(['m1', 'm2', 'm3']));
      await page.evaluate(({ theme, motion }) => Object.assign(document.documentElement.dataset, { theme, motion }), { theme, motion });
      await page.evaluate(() => document.fonts.ready);
      const side = page.getByRole('region', { name: 'Chats', exact: true });
      const first = side.locator('[data-sel-id="c1"]');
      const button = first.locator('button.kb-row');
      await button.click(); // quick click opens, not selects
      await expect(button).toHaveClass(/is-current/);
      await expect(first).toHaveAttribute('aria-selected', 'false');
      const identity = await first.elementHandle();
      const order = await side.locator('[data-sel-id]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-sel-id')!));
      await page.mouse.move(5, 5);
      const paint = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
      const point = (await button.boundingBox())!;
      await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
      await page.mouse.down();
      await expect(page.locator('.kb-selection-hold[data-phase="pending"]')).toHaveCount(1);
      await page.waitForTimeout(380);
      if (motion !== 'off') {
        expect(await page.locator('.kb-selection-hold[data-phase="held"]').evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.2);
      }
      if (width === 1440 && motion === 'full') {
        await page.screenshot({ path: path.join(shots, `hold-mid-${tag}.png`) });
      }
      await expect(first).toHaveAttribute('aria-selected', 'true');
      const last = side.locator('[data-sel-id="c6"]');
      const end = (await last.boundingBox())!;
      await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 4 });
      const range = order.slice(Math.min(order.indexOf('c1'), order.indexOf('c6')), Math.max(order.indexOf('c1'), order.indexOf('c6')) + 1);
      await expect.poll(() => side.locator('[data-sel-id][aria-selected="true"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-sel-id')))).toEqual(range);
      await page.mouse.up();
      await expect(first).toHaveAttribute('aria-selected', 'true');
      await page.mouse.move(5, 5);
      await page.waitForTimeout(300);
      const bar = side.getByRole('toolbar', { name: `${range.length} selected` });
      await expect(bar).toBeVisible();
      expect(await bar.evaluate((el) => el.closest('header') === el.closest('[data-pane="side"]')?.querySelector('header'))).toBe(true);
      expect(await first.evaluate((el, before) => el === before, identity)).toBe(true);
      expect(await button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(paint);
      expect(await page.evaluate(() => (window as unknown as Harness).__selectionScale)).toEqual(motion === 'full' ? ['c1'] : []);
      const circle = await first.locator('.kb-selslot .kb-selbox').evaluate((el) => ({ radius: parseFloat(getComputedStyle(el).borderTopLeftRadius), width: el.getBoundingClientRect().width }));
      expect(circle.radius).toBeGreaterThanOrEqual(circle.width / 2);
      await snapshot(`chats-${tag}`);
      await page.keyboard.press('Escape');
      await expect(side.getByRole('toolbar')).toHaveCount(0);
      await identity?.dispose();

      // Movement before 350 ms takes the actual native HTML DnD path, with its existing payload.
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Materials/ }).click();
      const materials = page.getByRole('region', { name: 'Materials', exact: true });
      const source = materials.locator('[data-sel-id="m3"]');
      const folder = materials.getByRole('list', { name: 'Folders' }).getByRole('button', { name: /^Physics/ });
      await expect(source).toBeVisible();
      await earlyNativeDrag(source, folder);

      await expect.poll(() => page.evaluate(() => (window as unknown as Harness).__kbFake.world.materials.find((m) => m.id === 'm3')?.folder_id)).toBe('phys');
      expect(await page.evaluate(() => (window as unknown as Harness).__selectionDrags.map((p) => JSON.parse(p))))
        .toContainEqual([{ type: 'material', id: 'm3' }]);
      await expect(page.locator('.kb-selection-hold[data-phase="pending"]')).toHaveCount(0);

      await materials.getByTestId('all-materials').click();
      const all = page.getByRole('region', { name: 'All materials' });
      await expect(all.getByRole('grid', { name: 'Materials' })).toBeVisible();
      await all.getByRole('button', { name: 'Select items' }).click();
      await page.getByRole('menuitem', { name: 'Choose…' }).click();
      const zero = all.getByRole('toolbar', { name: 'Choose items' });
      for (const action of await zero.locator('[data-action]').all()) await expect(action).toBeDisabled();
      await page.keyboard.press('Escape');
      const tableRows = all.locator('tbody [data-sel-id]');
      const tableIds = await tableRows.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-sel-id')));
      const body = (await all.locator('[data-sel-list]').boundingBox())!;
      const top = (await tableRows.first().boundingBox())!;
      await page.mouse.move(body.x + body.width - 20, body.y + body.height - 20);
      await page.mouse.down();
      await page.mouse.move(top.x + 25, top.y + 10, { steps: 8 });
      await expect(page.locator('.kb-selection-band')).toBeVisible();
      expect(await all.locator('[data-sel-list]').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
      await expect.poll(() => all.locator('[data-sel-id][aria-selected="true"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-sel-id')))).toEqual(tableIds);
      const bottom = (await tableRows.last().boundingBox())!;
      await page.mouse.move(bottom.x + 25, bottom.y + bottom.height / 2, { steps: 5 });
      await expect.poll(() => all.locator('[data-sel-id][aria-selected="true"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-sel-id')))).toEqual(tableIds.slice(-1));
      await snapshot(`band-${tag}`);
      await page.mouse.up();
      await expect(page.locator('.kb-selection-band')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await all.getByRole('radio', { name: 'Cards' }).click();
      const card = all.getByRole('grid', { name: 'Materials' }).locator('[data-sel-id="m1"]');
      await card.locator('button.kb-amc').click({ modifiers: ['Meta'] });
      await expect(card).toHaveAttribute('aria-selected', 'true');
      await expect(all.getByRole('toolbar', { name: '1 selected' })).toBeVisible();
      expect(await all.getByRole('toolbar').evaluate((el) => el.closest('header') !== null)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const overflowing = await page.locator('.kb-selbar').evaluateAll((bars) => bars.filter((b) => {
        const r = b.getBoundingClientRect();
        const p = b.closest('[data-pane]')?.getBoundingClientRect();
        return p && (r.left < p.left - 1 || r.right > p.right + 1);
      }).map((b) => b.textContent));
      expect(overflowing).toEqual([]);
      await snapshot(`cards-${tag}`);
      await page.keyboard.press('Escape');

      // Wiki is one selection across kinds; the app-wide hint budget is already exhausted.
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Wiki/ }).click();
      const wiki = page.getByRole('region', { name: 'Wiki', exact: true });
      const concept = wiki.getByRole('grid', { name: 'Concepts' }).locator('button.kb-row').first();
      await concept.click({ modifiers: ['Meta'] });
      await expect(wiki.getByRole('toolbar', { name: '1 selected' })).toBeVisible();
      await wiki.getByRole('button', { name: /^Notes\s*\d+$/ }).click();
      await wiki.getByRole('grid', { name: 'Notes' }).locator('button.kb-row').first().click({ modifiers: ['Meta'] });
      await expect(wiki.getByRole('toolbar', { name: '2 selected' })).toBeVisible();
      await expect(wiki.getByRole('toolbar')).toHaveCount(1);
      expect(await wiki.getByRole('toolbar').evaluate((el) => el.closest('header') !== null)).toBe(true);
      await expect(wiki.locator('.kb-selbar__hint')).toHaveCount(0);
      await snapshot(`wiki-${tag}`);
      await page.keyboard.press('Escape');

      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Chats/ }).click();
      await page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: /^All chats/ }).click();
      const chats = page.getByRole('region', { name: 'All chats', exact: true });
      const opened = await page.evaluate(() => (window as unknown as Harness).__kbFake.services.chats.getState().currentId);
      await chats.getByRole('button', { name: /^Transformer paper review/ }).click({ modifiers: ['Meta'] });
      await expect(chats.getByRole('toolbar', { name: '1 selected' })).toBeVisible();
      expect(await chats.getByRole('toolbar').evaluate((el) => el.closest('header') !== null)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as Harness).__kbFake.services.chats.getState().currentId)).toBe(opened);
      await snapshot(`all-chats-${tag}`);
      expect(errors.slice(firstError)).toEqual([]);
    });
  }
}
