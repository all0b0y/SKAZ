import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { auditPanes } from './paneAudit';
import type { BridgeRequest } from '../frontend/src/api/bridge';

// PANES-SPEC §2/§3/§7: every visible element of every column stays inside that
// column, at the default layout and at each column's minimum width, with heavy
// content — long transcript lines/words, a wide markdown table and code block in
// the note and the chat, a long session title. UI-only IPC fixture (the backend
// request handler is replaced in main): NOT real ASR, notes or model output.

const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime', 'shots', 'panes-content');

let app: ElectronApplication;
let page: Page;

const LONG_WORD = 'Сверхдлиннаяаббревиатурабезпробеловкотораянепереносится'.repeat(2);
const LINE = 'Эластичность спроса показывает, насколько сильно покупатели реагируют на изменение цены товара. ';
const TABLE = '| Показатель | Январь | Февраль | Март | Апрель | Май | Июнь | Июль | Комментарий |\n'
  + '|---|---|---|---|---|---|---|---|---|\n'
  + '| Выручка компании | 1 000 000 | 1 200 000 | 1 300 000 | 1 400 000 | 1 500 000 | 1 600 000 | 1 700 000 | рост по всем каналам продаж |\n';
const CODE = '```\nconst veryLongVariableName = computeSomethingWithAVeryLongFunctionName(argumentNumberOne, argumentNumberTwo, argumentNumberThree);\n```\n';
const NOTE = `# Спрос и предложение\n\n${LINE.repeat(3)}${LONG_WORD}\n\n${TABLE}\n${CODE}\n## Раздел\n\n${LINE.repeat(6)}\n`;

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-panes-content-')));
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
  await page.evaluate(() => window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } }));
  const settings = await page.evaluate(() => window.audiohelper.request({ method: 'GET', path: '/settings' }));
  await app.evaluate(({ ipcMain }, fixture) => {
    const id = 'panes-fixture';
    const session = { id, title: `Очень длинное название лекции про ${fixture.longWord}`, mode: 'legacy',
      status: 'stopped', duration_ms: 3_600_000, created_at: '2026-01-01T00:00:00Z' };
    const segments = Array.from({ length: 40 }, (_, i) => ({
      id: `s${i}`, start_ms: i * 61_000, end_ms: i * 61_000 + 60_000, language: 'ru',
      text: i === 3 ? `${fixture.line}${fixture.longWord} ${fixture.line}` : fixture.line.repeat(1 + (i % 4)),
    }));
    const note = { id: 'n1', revision: 1, content: fixture.note, title: 'Спрос и предложение',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', model: 'fixture', citations: [] };
    const messages = [
      { id: 'u1', role: 'user', content: `Что такое ${fixture.longWord}?`, created_at: 't' },
      { id: 'a1', role: 'assistant', content: `${fixture.line}\n\n${fixture.table}\n${fixture.code}`, created_at: 't', citations: [] },
    ];
    const detail = { session, segments, messages, notes: note, notes_list: [note], has_transcript: true };
    const orig = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers.get('backend:request')!;
    ipcMain.removeHandler('backend:request');
    ipcMain.handle('backend:request', async (event, req: BridgeRequest) => {
      if (req.path === '/settings' && req.method === 'GET') return fixture.settings;
      if (req.path === '/sessions' && req.method === 'GET') return { ok: true, status: 200, data: { sessions: [session] } };
      if (req.path === `/sessions/${id}` && req.method === 'GET') return { ok: true, status: 200, data: detail };
      if (req.path === `/sessions/${id}/notes` && req.method === 'GET') return { ok: true, status: 200, data: { notes: [note] } };
      if (req.path === `/sessions/${id}/notes/n1` && req.method === 'GET') return { ok: true, status: 200, data: note };
      if (req.path.startsWith(`/sessions/${id}`)) return { ok: false, status: 404, detail: 'UI fixture only' };
      return orig(event, req);
    });
  }, { settings, longWord: LONG_WORD, line: LINE, table: TABLE, code: CODE, note: NOTE });
  await page.reload();
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
  await page.getByText('Очень длинное название').first().click();
  await expect(page.locator('.segment, .transcript__flow').first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.close();
});

/** Drag a side panel's border so it lands on its minimum width. */
async function dragToMinimum(id: 'sessions' | 'assistant') {
  const name = id === 'sessions' ? 'Sessions panel width' : 'Assistant panel width';
  const handle = page.getByRole('separator', { name });
  const hb = (await handle.boundingBox())!;
  const pane = (await page.locator(`[data-pane="${id}"]`).boundingBox())!;
  const minimum = id === 'sessions' ? 200 : 280;
  const dx = (pane.width - minimum - 2) * (id === 'sessions' ? -1 : 1);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 300);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + dx, hb.y + 300, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function audit(label: string) {
  await page.waitForTimeout(350);
  const violations = await page.evaluate(auditPanes);
  await page.screenshot({ path: path.join(shots, `${label}.png`) });
  expect(violations, `${label}: elements outside their column or scrolling sideways\n${JSON.stringify(violations, null, 1)}`).toEqual([]);
}

test('transcript view: every element inside its column', async () => {
  test.setTimeout(120_000);
  await page.getByRole('tab', { name: /Transcript/ }).first().click();
  await audit('transcript-1400');
  // Centre at its minimum: both side panels wide in a narrow window.
  await page.setViewportSize({ width: 900, height: 820 });
  await audit('transcript-900');
  await page.setViewportSize({ width: 1400, height: 820 });
  await dragToMinimum('sessions');
  await audit('transcript-sessions-min');
  // Centre squeezed to its own minimum by a wide rail: the layout follows the
  // COLUMN — time goes above the text — not the window, which stays 1400 wide.
  const handle = page.getByRole('separator', { name: 'Sessions panel width' });
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 300);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 900, hb.y + 300, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const centre = (await page.locator('[data-pane="center"]').boundingBox())!;
  // The rail stops at its own maximum (560) — the centre is as narrow as the
  // layout allows at this window width, and never below its 360 minimum.
  expect(centre.width, 'centre squeezed by the rail').toBeLessThanOrEqual(520);
  expect(centre.width).toBeGreaterThanOrEqual(359);
  const stacked = await page.evaluate(() => {
    const seg = document.querySelector('.segment')!;
    const time = seg.querySelector('.segment__time')!.getBoundingClientRect();
    const text = seg.querySelector('.segment__text')!.getBoundingClientRect();
    return { timeAbove: time.bottom <= text.top + 1, textFullWidth: text.width };
  });
  expect(stacked.timeAbove, 'narrow column: time above the text').toBe(true);
  await audit('transcript-centre-min');
  // Reset for the following tests.
  await page.evaluate(() => localStorage.removeItem('audiohelper.panels'));
  await page.reload();
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
  await page.getByText('Очень длинное название').first().click();
  await expect(page.locator('.segment').first()).toBeVisible({ timeout: 15_000 });
});

test('notes view with a wide table and code: every element inside its column', async () => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.getByRole('tab', { name: /Notes/ }).first().click();
  const open = page.getByRole('button', { name: /Open Спрос/ });
  if (await open.count()) await open.click();
  await expect(page.locator('.notes__page')).toBeVisible();
  await audit('notes-1400');
  await page.setViewportSize({ width: 900, height: 820 });
  await audit('notes-900');
  await page.setViewportSize({ width: 1400, height: 820 });
  await dragToMinimum('sessions');
  await audit('notes-sessions-min');
});

test('chat with a wide table, code and a long word: every element inside its column', async () => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 820 });
  await expect(page.locator('[data-pane="assistant"] .msg').first()).toBeVisible();
  await audit('chat-1400');
  await dragToMinimum('assistant');
  await audit('chat-min');
});

/** Header, body and footer of one column by their boxes. */
const columnParts = (pane: 'center' | 'assistant', body: string, head: string, foot: string) =>
  page.evaluate(([p, b, h, f]) => {
    const r = (sel: string) => {
      const el = document.querySelector(`[data-pane="${p}"] ${sel}`);
      const x = el?.getBoundingClientRect();
      return x ? { top: x.top, bottom: x.bottom, height: x.height } : null;
    };
    const col = document.querySelector(`[data-pane="${p}"]`)!.getBoundingClientRect();
    const scroller = document.querySelector(`[data-pane="${p}"] ${b}`) as HTMLElement | null;
    return { col: { top: col.top, bottom: Math.min(col.bottom, window.innerHeight) }, head: r(h), body: r(b), foot: r(f),
      // The fade must actually paint: the attribute alone proves nothing.
      fadeTop: !!scroller?.hasAttribute('data-fade-start') && getComputedStyle(scroller).maskImage !== 'none',
      fadeBottom: !!scroller?.hasAttribute('data-fade-end') && getComputedStyle(scroller).maskImage !== 'none',
      scrollTop: scroller?.scrollTop ?? 0 };
  }, [pane, body, head, foot] as const);

test('vertical: header and footer pinned, only the body scrolls and fades at hidden edges', async () => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.getByRole('tab', { name: /Transcript/ }).first().click();
  await page.waitForTimeout(400);
  const scroller = page.locator('[data-pane="center"] .transcript');
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  let t = await columnParts('center', '.transcript', '.center__tabs', '.recorder');
  expect(t.fadeTop, 'at the top: no top fade').toBe(false);
  expect(t.fadeBottom, 'more below: bottom fade').toBe(true);
  const headBefore = t.head!.top;
  const footBefore = t.foot!.top;
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
  await page.waitForTimeout(200);
  t = await columnParts('center', '.transcript', '.center__tabs', '.recorder');
  expect(t.fadeTop && t.fadeBottom, 'in the middle: both edges fade').toBe(true);
  expect(t.head!.top, 'header does not move').toBe(headBefore);
  expect(t.foot!.top, 'footer does not move').toBe(footBefore);
  expect(t.foot!.bottom, 'footer inside the column').toBeLessThanOrEqual(t.col.bottom + 1);
  await page.screenshot({ path: path.join(shots, 'vertical-transcript-middle.png') });
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  t = await columnParts('center', '.transcript', '.center__tabs', '.recorder');
  expect(t.fadeBottom, 'at the end: no bottom fade').toBe(false);
});

test('vertical: a long question grows the composer only to ~40% of the column', async () => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 820 });
  const input = page.getByRole('textbox', { name: 'Question' });
  await input.fill('Первая строка вопроса\n'.repeat(3));
  await page.waitForTimeout(150);
  const small = (await input.boundingBox())!.height;
  expect(small, 'grows with a few lines').toBeGreaterThan(48);
  await input.fill('Очень длинный вопрос о записи\n'.repeat(60));
  await page.waitForTimeout(200);
  const a = await columnParts('assistant', '.assistant__thread', '.assistant__head', '.assistant__compose');
  const box = (await input.boundingBox())!;
  const column = a.col.bottom - a.col.top;
  expect(box.height, 'composer capped at ~40% of the column').toBeLessThanOrEqual(column * 0.4 + 2);
  expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight), 'the rest scrolls inside the field').toBe(true);
  expect(a.foot!.bottom, 'composer inside the column').toBeLessThanOrEqual(a.col.bottom + 1);
  expect(a.body!.height, 'the thread keeps room').toBeGreaterThanOrEqual(119);
  const send = (await page.getByRole('button', { name: 'Send question' }).boundingBox())!;
  expect(send.y + send.height, 'send button visible').toBeLessThanOrEqual(a.col.bottom + 1);
  await page.screenshot({ path: path.join(shots, 'vertical-composer-capped.png') });
  await input.fill('');
});

test('vertical: the lowest window keeps every body usable', async () => {
  test.setTimeout(60_000);
  // The window cannot be lower than 640px (BrowserWindow minHeight in
  // electron/main.ts); test below it, with margin. Bodies are the flexible rows
  // between fixed-height header and footer, so they keep the remainder — no
  // min-height is needed (one would push the footer out of the column instead).
  await page.setViewportSize({ width: 1100, height: 560 });
  await page.getByRole('tab', { name: /Notes/ }).first().click();
  await page.waitForTimeout(400);
  for (const [pane, body, head, foot] of [
    ['center', '.notes__body', '.center__tabs', '.recorder'],
    ['assistant', '.assistant__thread', '.assistant__head', '.assistant__compose'],
  ] as const) {
    const c = await columnParts(pane, body, head, foot);
    expect(c.body, `${pane} body present`).not.toBeNull();
    expect(c.body!.height, `${pane} body keeps ≥120px`).toBeGreaterThanOrEqual(119);
    expect(c.foot!.bottom, `${pane} footer inside the window`).toBeLessThanOrEqual(c.col.bottom + 1);
  }
  await page.screenshot({ path: path.join(shots, 'vertical-low-window.png') });
  await audit('low-window');
  await page.setViewportSize({ width: 1400, height: 820 });
});

test('overlay: a floating panel is a screen of its own; a click on the centre closes it', async () => {
  test.setTimeout(90_000);
  // The real window cannot be narrower than 960px (electron/main.ts minWidth),
  // where every panel docks; the overlay exists for narrower viewports, so it is
  // exercised by overriding the viewport.
  await page.setViewportSize({ width: 820, height: 820 });
  await page.waitForTimeout(400);
  const slot = page.locator('.panel-slot[data-panel="assistant"]');
  await expect(slot).toHaveAttribute('data-state', 'closed');
  await page.getByRole('button', { name: 'Show assistant' }).click();
  await page.waitForTimeout(400);
  await expect(slot).toHaveAttribute('data-state', 'overlay');
  const overlay = (await slot.boundingBox())!;

  // Its dropdown stays inside the floating panel, not the window.
  await page.locator('[data-pane="assistant"] [aria-haspopup]:visible').first().click();
  await page.waitForTimeout(200);
  const pop = await page.evaluate(() => {
    const el = document.querySelector('.codex-picker__popover, .codex-scope__popover');
    const r = el?.getBoundingClientRect();
    return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
  });
  expect(pop, 'dropdown opened').not.toBeNull();
  expect(pop!.left).toBeGreaterThanOrEqual(overlay.x - 1);
  expect(pop!.right).toBeLessThanOrEqual(overlay.x + overlay.width + 1);
  await page.screenshot({ path: path.join(shots, 'overlay-dropdown.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // Every element of the floating panel inside it; the centre is dimmed under it.
  await audit('overlay-open');
  const scrim = page.locator('.workspace__scrim');
  await expect(scrim).toBeVisible();

  // A click on the centre closes the floating panel, and does nothing else.
  const centre = (await page.locator('[data-pane="center"]').boundingBox())!;
  await page.mouse.click(centre.x + 60, centre.y + 200);
  await page.waitForTimeout(400);
  await expect(slot).toHaveAttribute('data-state', 'closed');
  await expect(scrim).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show assistant' })).toBeVisible();

  // It docks again on its own once the window is wide enough.
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.waitForTimeout(400);
  await expect(slot).toHaveAttribute('data-state', 'docked');
});

test('final pass: every column at its minimum, light and dark', async () => {
  test.setTimeout(120_000);
  await page.evaluate(() => localStorage.removeItem('audiohelper.panels'));
  await page.reload();
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
  await page.getByText('Очень длинное название').first().click();
  await expect(page.locator('.segment').first()).toBeVisible({ timeout: 15_000 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    // Window at the real minimum (960): centre squeezed toward 360.
    await page.setViewportSize({ width: 960, height: 640 });
    for (const tab of ['Transcript', 'Notes']) {
      await page.getByRole('tab', { name: new RegExp(tab) }).first().click();
      await audit(`final-${theme}-960-${tab.toLowerCase()}`);
    }
    await page.setViewportSize({ width: 1400, height: 820 });
    await dragToMinimum('sessions');
    await dragToMinimum('assistant');
    await audit(`final-${theme}-sides-min`);
    await page.evaluate(() => localStorage.removeItem('audiohelper.panels'));
    await page.reload();
    await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
    await page.getByText('Очень длинное название').first().click();
    await expect(page.locator('.segment').first()).toBeVisible({ timeout: 15_000 });
  }
});
