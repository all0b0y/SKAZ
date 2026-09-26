import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Every column is a screen of its own (.dev/docs/PANES-SPEC.md). Geometry only,
// in the real built Electron shell: popups raised at a column's edge stay inside
// that column, at several window widths. Fixture sessions/notes through the local
// API — no ASR, no model calls. Isolated profile.

const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime', 'shots', 'panes');
const TOLERANCE = 1;

type Box = { left: number; top: number; right: number; bottom: number };
type PaneId = 'sessions' | 'center' | 'assistant';

let app: ElectronApplication;
let page: Page;

const paneBox = (id: PaneId) => page.evaluate((pane) => {
  const r = document.querySelector(`[data-pane="${pane}"]`)!.getBoundingClientRect();
  return { left: r.left, top: r.top, right: Math.min(r.right, window.innerWidth), bottom: Math.min(r.bottom, window.innerHeight) };
}, id);

/** The one open popup (menu / dropdown / popover dialog), by its box. */
const popupBox = (selector: string) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}, selector);

function expectInside(label: string, inner: Box | null, outer: Box) {
  expect(inner, `${label}: popup is open`).not.toBeNull();
  const b = inner!;
  expect(b.left, `${label}: left edge inside the column (${JSON.stringify(b)} in ${JSON.stringify(outer)})`).toBeGreaterThanOrEqual(outer.left - TOLERANCE);
  expect(b.right, `${label}: right edge inside the column (${JSON.stringify(b)} in ${JSON.stringify(outer)})`).toBeLessThanOrEqual(outer.right + TOLERANCE);
  expect(b.top, `${label}: top inside the column`).toBeGreaterThanOrEqual(outer.top - TOLERANCE);
  expect(b.bottom, `${label}: bottom inside the column`).toBeLessThanOrEqual(outer.bottom + TOLERANCE);
}

const closeAll = async () => {
  await page.keyboard.press('Escape');
  await page.mouse.click(2, 2);
  await page.waitForTimeout(150);
};

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-panes-')));
  app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: userData, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1400, height: 820 });
  await expect.poll(() => page.evaluate(async () => (await window.audiohelper.getBackendStatus()).phase),
    { timeout: 60_000 }).toBe('ready');
  await page.evaluate(async () => {
    await window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } });
    const s = await window.audiohelper.request<{ id: string }>({ method: 'POST', path: '/sessions',
      body: { title: 'Очень длинное название лекции, которое не помещается в узкую панель сессий', mode: 'legacy' } });
    const id = (s.data as { id: string }).id;
    const n = await window.audiohelper.request<{ id: string; revision: number }>({ method: 'POST', path: `/sessions/${id}/notes/empty` });
    const note = n.data as { id: string; revision: number };
    const line = 'Эластичность показывает, насколько сильно спрос реагирует на изменение цены, и это длинная строка. ';
    const content = `# Спрос и предложение\n\n${line.repeat(6)}\n\n## Раздел\n\n${line.repeat(10)}\n`;
    await window.audiohelper.request({ method: 'PATCH', path: `/sessions/${id}/notes/${note.id}`, body: { content, expected_revision: note.revision } });
  });
  await page.reload();
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
  await page.getByText('Очень длинное название').first().click();
  await page.getByRole('tab', { name: /Notes/ }).first().click();
  await page.getByRole('button', { name: /Open Спрос/ }).click();
  await page.waitForTimeout(600);
});

test.afterAll(async () => {
  await app?.close();
});

for (const width of [1400, 1000]) {
  test(`popups stay inside their column — window ${width}`, async () => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(400);
    const centre = await paneBox('center');

    // 1. Right click in the note text, at the centre column's right edge — the
    //    reported case: the menu used to spill over the chat.
    const text = page.locator('.notes__page').first();
    const tb = (await text.boundingBox())!;
    const x = Math.min(centre.right - 6, tb.x + tb.width - 4);
    await page.mouse.click(x, tb.y + 40, { button: 'right' });
    await page.waitForTimeout(200);
    expectInside('note text menu at right edge', await popupBox('.context-menu'), centre);
    await page.screenshot({ path: path.join(shots, `${width}-01-note-menu-right-edge.png`) });
    await closeAll();

    // 2. Same, at the bottom-right of the document, just above the recorder: the
    //    menu must open upwards and leftwards.
    const recorderTop = (await page.locator('.recorder').boundingBox())!.y;
    await page.mouse.click(x, recorderTop - 12, { button: 'right' });
    await page.waitForTimeout(200);
    const corner = await popupBox('.context-menu');
    expect(corner, 'right click at the column corner opens the note menu').not.toBeNull();
    expectInside('menu at bottom-right corner', corner, centre);
    await page.screenshot({ path: path.join(shots, `${width}-01b-note-menu-corner.png`) });
    await closeAll();

    // 3. Right click on the note tab.
    const tab = page.locator('.note-tab').first();
    await tab.click({ button: 'right' });
    await page.waitForTimeout(200);
    expectInside('note tab menu', await popupBox('.context-menu'), centre);
    await closeAll();

    // 4. The "+" dropdown at the right end of the tab row.
    await page.getByRole('button', { name: 'New notes' }).click();
    await page.waitForTimeout(200);
    expectInside('"+" dropdown', await popupBox('.note-menu'), centre);
    await page.screenshot({ path: path.join(shots, `${width}-02-plus-menu.png`) });
    await closeAll();

    // 5. Session "…" menu in the rail, dragged to its minimum width.
    const rail = await paneBox('sessions');
    if (rail.right - rail.left > 1) {
      await page.locator('.session__more').first().click();
      await page.waitForTimeout(200);
      expectInside('session menu', await popupBox('.session-menu'), rail);
      await page.screenshot({ path: path.join(shots, `${width}-03-session-menu.png`) });
      await closeAll();
    }

    // 6. Every dropdown trigger in the assistant column.
    const assistant = await paneBox('assistant');
    if (assistant.right - assistant.left > 1) {
      const triggers = page.locator('[data-pane="assistant"] [aria-haspopup]:visible');
      const count = await triggers.count();
      let opened = 0;
      for (let i = 0; i < count; i += 1) {
        const trigger = triggers.nth(i);
        if (await trigger.isDisabled()) continue;
        await trigger.click();
        await page.waitForTimeout(200);
        const pop = await popupBox('.codex-picker__popover, .codex-queue__popover, .codex-scope__popover');
        expectInside(`assistant dropdown "${await trigger.getAttribute('aria-label') ?? await trigger.textContent()}"`, pop, assistant);
        opened += 1;
        await closeAll();
      }
      // The API engine always has its search-scope dropdown: at least that one ran.
      expect(opened, 'assistant dropdowns actually opened').toBeGreaterThan(0);
    }
  });
}

test('a menu in the narrowest rail is capped to the rail', async () => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.waitForTimeout(300);
  // Drag the sessions border to its minimum (200px): the menu is 228px wide.
  const handle = page.getByRole('separator', { name: 'Sessions panel width' });
  const hb = (await handle.boundingBox())!;
  const rail0 = await paneBox('sessions');
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - (rail0.right - rail0.left - 205), hb.y + 200, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const rail = await paneBox('sessions');
  expect(rail.right - rail.left).toBeLessThan(228);
  await page.locator('.session__more').first().click();
  await page.waitForTimeout(200);
  expectInside('session menu in a 200px rail', await popupBox('.session-menu'), rail);
  await page.screenshot({ path: path.join(shots, 'narrow-rail-session-menu.png') });
  await closeAll();
});

test('15 open notes: the tab row shrinks, scrolls and never widens the column', async () => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.waitForTimeout(300);
  const centre0 = await paneBox('center');
  for (let i = 0; i < 15; i += 1) {
    await page.getByRole('button', { name: 'New notes' }).click();
    await page.getByRole('menuitem', { name: 'Create empty' }).click();
    await page.waitForTimeout(120);
  }
  await expect(page.locator('.note-tab')).toHaveCount(16);
  for (const width of [1400, 1000]) {
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(400);
    const centre = await paneBox('center');
    if (width === 1400) expect(centre.right - centre.left, 'the centre did not grow').toBeLessThanOrEqual(centre0.right - centre0.left + 1);
    const row = await page.evaluate(() => {
      const strip = document.querySelector('.note-tabs__strip')!;
      const bar = document.querySelector('.note-tabs')!.getBoundingClientRect();
      const tabs = [...document.querySelectorAll('.note-tab')].map((t) => t.getBoundingClientRect());
      const active = document.querySelector('.note-tab--on')!.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      const pinned = [...document.querySelectorAll('.note-tabs__add')].map((b) => b.getBoundingClientRect());
      return {
        bar: { left: bar.left, right: bar.right },
        strip: { left: s.left, right: s.right },
        scrolls: strip.scrollWidth > strip.clientWidth,
        fadeEnd: strip.hasAttribute('data-fade-end'), fadeStart: strip.hasAttribute('data-fade-start'),
        minTab: Math.min(...tabs.map((t) => t.width)),
        active: { left: active.left, right: active.right },
        pinned: pinned.map((b) => ({ left: b.left, right: b.right })),
      };
    });
    expect(row.bar.right, `@${width} tab bar inside the column`).toBeLessThanOrEqual(centre.right + TOLERANCE);
    expect(row.scrolls, `@${width} the row scrolls instead of growing`).toBe(true);
    expect(row.minTab, `@${width} tabs shrink but not below 90px`).toBeGreaterThanOrEqual(89);
    // The last-created tab is active and is brought into view.
    expect(row.active.left, `@${width} active tab visible`).toBeGreaterThanOrEqual(row.strip.left - TOLERANCE);
    expect(row.active.right, `@${width} active tab visible`).toBeLessThanOrEqual(row.strip.right + TOLERANCE);
    expect(row.fadeStart || row.fadeEnd, `@${width} an edge hiding tabs fades`).toBe(true);
    // Pinned "⋯" and "+" stay visible, inside the column, outside the scrolling strip.
    expect(row.pinned.length, `@${width} "⋯" appears on overflow`).toBe(2);
    for (const b of row.pinned) {
      expect(b.left).toBeGreaterThanOrEqual(row.strip.right - TOLERANCE);
      expect(b.right).toBeLessThanOrEqual(centre.right + TOLERANCE);
    }
    await page.screenshot({ path: path.join(shots, `${width}-04-fifteen-tabs.png`) });
  }
  // Wheel scrolls the row sideways; the far-left tab comes into view.
  const strip = page.locator('.note-tabs__strip');
  const sb = (await strip.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, -200);
  await page.waitForTimeout(200);
  expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);
  expect(await strip.evaluate((el) => el.hasAttribute('data-fade-start'))).toBe(false);
  await page.screenshot({ path: path.join(shots, '05-fifteen-tabs-scrolled-start.png') });
  // "⋯" lists every open note and stays inside the column; picking one reveals it.
  const centre = await paneBox('center');
  await page.getByRole('button', { name: 'All open notes' }).click();
  const list = page.getByRole('menu', { name: 'All open notes' });
  await expect(list.getByRole('menuitemradio')).toHaveCount(16);
  expectInside('"⋯" list', await popupBox('.note-menu--list'), centre);
  await page.screenshot({ path: path.join(shots, '06-all-tabs-list.png') });
  await list.getByRole('menuitemradio').last().click();
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => {
    const s = document.querySelector('.note-tabs__strip')!.getBoundingClientRect();
    const a = document.querySelector('.note-tab--on')!.getBoundingClientRect();
    return a.left >= s.left - 1 && a.right <= s.right + 1;
  });
  expect(shown, 'picked tab scrolled into view').toBe(true);
});
