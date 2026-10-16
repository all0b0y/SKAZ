import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { BridgeRequest } from '../frontend/src/api/bridge';

// .dev/docs/UI-CLEANUP-IMPORT-TRANSCRIPT-SPEC.md in the built Electron shell: the
// import card in every state, the transcript without its notice strip, the
// session row highlight, Jump to live contrast, the step-by-step Import dialog.
// UI-only IPC fixture (the backend request handler is replaced in main): NOT a
// real import, ASR or paid call — nothing here reaches a provider.

const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime', 'shots', 'ui-cleanup');
const STATUSES = ['downloading', 'processing', 'interrupted', 'failed'];
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

let app: ElectronApplication;
let page: Page;

const row = (name: string) => page.locator('.session', { hasText: name });
const openSession = (name: string) => page.locator('.session__select', { hasText: name }).click();

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-ui-cleanup-')));
  app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      SKAZ_OPTIN_SMOKE_USER_DATA: userData, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      SKAZ_ALLOW_MODEL_DOWNLOAD: '0', SKAZ_LIVE_FINALITY: '0', SKAZ_LOCAL_SPEECH_GATE: '0',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1400, height: 820 });
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
    { timeout: 60_000 }).toBe('ready');
  await page.evaluate(() => window.skaz.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } }));
  const settings = await page.evaluate(() => window.skaz.request({ method: 'GET', path: '/settings' }));
  await app.evaluate(({ ipcMain }, f) => {
    const flags = globalThis as { importsIdle?: boolean };
    const created = new Date(Date.now() - 95_000).toISOString();
    const sessions = [
      ...f.statuses.map((st, i) => ({ id: `imp-${st}`, title: `Импорт ${st}`, mode: 'legacy', origin: 'import',
        status: 'stopped', duration_ms: 0, created_at: `2026-01-0${i + 1}T00:00:00Z` })),
      { id: 'yt', title: 'Лекция с YouTube', mode: 'legacy', origin: 'import', status: 'stopped', duration_ms: 600_000, created_at: '2026-01-09T00:00:00Z' },
      { id: 'a', title: 'Обычная сессия А', mode: 'legacy', status: 'stopped', duration_ms: 600_000, created_at: '2026-01-08T00:00:00Z' },
    ];
    const youtube = { kind: 'youtube', url: 'https://youtu.be/abcdefghijk', video_id: 'abcdefghijk',
      name: 'Лекция по экономике — часть 3', path: '', size_bytes: 0, available: true };
    const local = (available: boolean) => ({ kind: 'local', name: 'Запись встречи 2026-01-02.m4a',
      path: '/Users/x/Downloads/Запись встречи 2026-01-02.m4a', size_bytes: 1, available });
    const view = (id: string, status: string) => ({ session_id: id, status, translate: status === 'processing', model: 'fixture',
      source: status === 'downloading' || id === 'yt' ? youtube : local(status !== 'interrupted'),
      declared_duration_ms: 3_540_000, created_at: created,
      error: status === 'failed' ? 'Provider returned 402: insufficient balance' : null });
    const segments = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, start_ms: i * 20_000, end_ms: i * 20_000 + 19_000,
      text: 'Эластичность спроса показывает, насколько сильно покупатели реагируют на изменение цены. '.repeat(1 + (i % 3)) }));
    ipcMain.removeHandler('backend:request');
    ipcMain.handle('backend:request', async (_event, req: BridgeRequest) => {
      const ok = (data: unknown) => ({ ok: true, status: 200, data });
      if (req.path === '/settings') return f.settings;
      if (req.path === '/sessions') return ok({ sessions });
      if (req.path === '/imports/preview') {
        return ok({ title: 'Лекция по экономике — часть 3', duration_ms: 3_540_000,
          source: (req.body as { source?: unknown } | undefined)?.source, existing_session_ids: [] });
      }
      if (req.path === '/imports' && req.method === 'GET') {
        return ok({ supported_extensions: ['m4a'], max_duration_ms: 18_000_000, rate_per_hour_usd: 0.12,
          translation_rate_per_hour_usd: 0.2, warn_above_usd: 1, cloud_consent: true, has_api_key: true,
          active_imports: 0, max_concurrent_imports: 1, destination: 'App internal storage', markdown_enabled: false });
      }
      if (req.path === '/imports/active') {
        return ok({ imports: flags.importsIdle ? [] : f.statuses.map((st) => view(`imp-${st}`, st)) });
      }
      const imported = req.path.match(/^\/imports\/([^/]+)$/);
      if (imported && req.method === 'GET') {
        const id = imported[1]!;
        return ok(id === 'yt' || flags.importsIdle ? view(id, 'completed') : view(id, id.replace('imp-', '')));
      }
      const detail = req.path.match(/^\/sessions\/([^/]+)$/);
      if (detail && req.method === 'GET') {
        return ok({ session: sessions.find((s) => s.id === detail[1]), segments, messages: [], notes: null });
      }
      return { ok: false, status: 404, detail: 'UI fixture only' };
    });
  }, { settings, statuses: STATUSES });
  await page.reload();
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test('import card: one centred card in every state; caveats only where they matter (§4)', async () => {
  test.setTimeout(90_000);
  for (const status of STATUSES) {
    await openSession(`Импорт ${status}`);
    const card = page.locator('.import-card');
    await expect(card.locator('.import-card__status')).toBeVisible();
    const geo = await page.evaluate(() => {
      const c = document.querySelector('.import-card')!.getBoundingClientRect();
      const p = document.querySelector('[data-pane="center"] .center__content')!.getBoundingClientRect();
      return { dx: Math.abs((c.left + c.right) / 2 - (p.left + p.right) / 2), inside: c.left >= p.left && c.right <= p.right,
        text: document.querySelector('.center__content')!.textContent ?? '' };
    });
    expect(geo.dx, `${status}: centred in the column`).toBeLessThan(2);
    expect(geo.inside, `${status}: inside the column`).toBe(true);
    expect(geo.text, `${status}: the name, not the path`).not.toMatch(/\/Users\/x\/Downloads/);
    expect(geo.text, `${status}: no standing caveats`).not.toMatch(/switch sessions|No processing percentage|may not stop provider charges/);
    const running = status === 'downloading' || status === 'processing';
    await expect(card.locator('.import-card__progress')).toHaveCount(running ? 1 : 0);
    await expect(card.getByRole('button', { name: 'Cancel import' })).toHaveCount(running ? 1 : 0);
    await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(running ? 0 : 1);
    await expect(card.getByRole('button', { name: 'Delete' })).toHaveCount(running ? 0 : 1);
    if (!running) await expect(card).toContainText('a new paid transcription is created');
    if (status === 'failed') await expect(card.getByRole('alert')).toHaveText('Provider returned 402: insufficient balance');
    await page.screenshot({ path: path.join(shots, `import-${status}.png`) });
  }
  // The charge caveat lives in the cancel confirmation; nothing is cancelled without it.
  await openSession('Импорт processing');
  await page.locator('.import-card').getByRole('button', { name: 'Cancel import' }).click();
  const confirm = page.getByRole('dialog', { name: 'Cancel import?' });
  await expect(confirm).toContainText('may not stop provider charges');
  await page.screenshot({ path: path.join(shots, 'import-cancel-confirm.png') });
  await confirm.getByRole('button', { name: 'Keep importing' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.import-card__status')).toHaveText('Provider is processing');
});

test('transcript: no strip above the text; the original opens from the session menu (§1)', async () => {
  test.setTimeout(60_000);
  await openSession('Лекция с YouTube');
  await expect(page.locator('.segment').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.native-transcript-notice')).toHaveCount(0);
  await expect(page.locator('[data-pane="center"]')).not.toContainText('Open original on YouTube');
  const gap = await page.evaluate(() => document.querySelector('.segment')!.getBoundingClientRect().top
    - document.querySelector('.center__tabs')!.getBoundingClientRect().bottom);
  expect(gap, 'the text starts right under the tabs').toBeLessThanOrEqual(32);
  // Time codes still link to the moment in the video.
  await expect(page.locator('.segment__time a').first()).toHaveAttribute('href', /youtube\.com\/watch\?v=abcdefghijk&t=0s/);
  // …styled like the plain time, not as a default blue link.
  const link = await page.locator('.segment__time a').first().evaluate((a) => ({
    color: getComputedStyle(a).color, time: getComputedStyle(a.parentElement!).color, line: getComputedStyle(a).textDecorationLine }));
  expect(link.color).toBe(link.time);
  expect(link.line).toBe('none');
  await page.screenshot({ path: path.join(shots, 'transcript-top.png'), clip: { x: 250, y: 38, width: 790, height: 300 } });

  await row('Лекция с YouTube').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Session actions' });
  await expect(menu.getByRole('menuitem', { name: 'Open original' })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'session-menu-open-original.png') });
  await page.keyboard.press('Escape');
  await row('Обычная сессия А').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Open original' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('session row: one tint over the whole row, switched in one frame, focus rings the row (§3)', async () => {
  test.setTimeout(60_000);
  await openSession('Лекция с YouTube');
  await expect(row('Лекция с YouTube')).toHaveClass(/session--active/);
  await openSession('Обычная сессия А');
  await expect(row('Обычная сессия А')).toHaveClass(/session--active/);
  const s = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.session')];
    const find = (t: string) => rows.find((r) => r.textContent!.includes(t))!;
    const active = find('Обычная сессия А');
    const old = find('Лекция с YouTube');
    const box = active.getBoundingClientRect();
    const more = active.querySelector('.session__more')!.getBoundingClientRect();
    return {
      activeBg: getComputedStyle(active).backgroundColor,
      oldBg: getComputedStyle(old).backgroundColor,
      moreBg: getComputedStyle(active.querySelector('.session__more')!).backgroundColor,
      selectBg: getComputedStyle(active.querySelector('.session__select')!).backgroundColor,
      moreInside: more.left >= box.left && more.right <= box.right,
      transitions: rows.map((r) => [getComputedStyle(r).transitionProperty, getComputedStyle(r).transitionDuration]),
    };
  });
  expect(s.oldBg, 'the previous row is cleared').toBe(TRANSPARENT);
  expect(s.activeBg, 'the selected row is tinted').not.toBe(TRANSPARENT);
  expect(s.selectBg, 'the name carries no patch of its own').toBe(TRANSPARENT);
  expect(s.moreBg, '"…" carries no patch of its own').toBe(TRANSPARENT);
  expect(s.moreInside, '"…" is inside the highlighted row').toBe(true);
  // No colour transition: the old row cannot still be fading while the new one is lit.
  for (const [property, duration] of s.transitions) {
    if (duration !== '0s') expect(property).not.toMatch(/all|background/);
  }

  // Hover tints the whole row, lighter than the selection.
  const other = row('Импорт failed');
  const ob = (await other.boundingBox())!;
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  const hoverBg = await other.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(hoverBg).not.toBe(TRANSPARENT);
  expect(hoverBg).not.toBe(s.activeBg);

  // Keyboard focus rings the row, not the button inside it.
  await page.locator('.session__select', { hasText: 'Обычная сессия А' }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const r = el.closest('.session') as HTMLElement | null;
    return { isSelect: el.classList.contains('session__select'), visible: el.matches(':focus-visible'),
      rowOutline: r ? getComputedStyle(r).outlineStyle : 'none', ownOutline: getComputedStyle(el).outlineStyle };
  });
  expect(ring.isSelect && ring.visible, 'keyboard focus is on the session name').toBe(true);
  expect(ring.rowOutline, 'the row is ringed').toBe('solid');
  expect(ring.ownOutline, 'the name has no ring of its own').toBe('none');
  await page.screenshot({ path: path.join(shots, 'session-row-focus.png'), clip: { x: 0, y: 150, width: 260, height: 520 } });
});

test('Jump to live: a solid, contrasting pill in both themes, label unchanged (§2)', async () => {
  test.setTimeout(60_000);
  await openSession('Лекция с YouTube');
  await expect(page.locator('.segment').first()).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    // The pill appears only on a live native transcript scrolled away from its end;
    // its exact markup is injected to check the style against the real page.
    // It lives on the native transcript layout, which anchors it.
    await page.evaluate(() => document.querySelector('.transcript-layout')!.classList.add('transcript-layout--native'));
    await page.evaluate(() => document.querySelector('.transcript-layout')!.insertAdjacentHTML('beforeend',
      '<button type="button" class="transcript__follow" data-fixture="1"><span class="transcript__follow-live" aria-hidden="true"></span><span>Jump to live</span></button>'));
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => {
      const b = document.querySelector('.transcript__follow')!;
      const cs = getComputedStyle(b);
      const pixels = (color: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      };
      const luminance = (color: string) => pixels(color).slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
      const contrast = (a: string, b: string) => {
        const values = [luminance(a), luminance(b)];
        return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
      };
      const background = getComputedStyle(document.querySelector('.center')!).backgroundColor;
      return { opacity: cs.opacity, label: b.textContent, alpha: pixels(cs.backgroundColor)[3],
        pageContrast: contrast(cs.backgroundColor, background), labelContrast: contrast(cs.backgroundColor, cs.color) };
    });
    expect(s.label).toBe('Jump to live');
    expect(s.opacity).toBe('1');
    expect(s.alpha, `${theme}: solid, no alpha`).toBe(255);
    expect(s.pageContrast, `${theme}: pill against the page`).toBeGreaterThanOrEqual(4.5);
    expect(s.labelContrast, `${theme}: label against the pill`).toBeGreaterThanOrEqual(4.5);
    const pill = (await page.locator('.transcript__follow').boundingBox())!;
    const centre = (await page.locator('[data-pane="center"]').boundingBox())!;
    expect(pill.x, `${theme}: pill inside the transcript column`).toBeGreaterThanOrEqual(centre.x);
    expect(pill.x + pill.width).toBeLessThanOrEqual(centre.x + centre.width);
    await page.screenshot({ path: path.join(shots, `jump-to-live-${theme}.png`),
      clip: { x: centre.x, y: Math.max(0, pill.y - 120), width: centre.width, height: pill.height + 150 } });
    await page.evaluate(() => document.querySelector('[data-fixture="1"]')?.remove());
  }
  await page.evaluate(() => document.querySelector('.transcript-layout')!.classList.remove('transcript-layout--native'));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
});

test('Import media: one dialog that unfolds; the source is never repeated (§5)', async () => {
  test.setTimeout(90_000);
  await app.evaluate(() => { (globalThis as { importsIdle?: boolean }).importsIdle = true; });
  await page.reload();
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
  await openSession('Обычная сессия А');
  // Import opens only while no import runs; the fixture settles them all now.
  await expect(page.locator('.session__meta', { hasText: 'Importing…' })).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Import audio' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import media' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Check link' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Choose file' })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'import-dialog-1-source.png') });

  // A YouTube link checks itself; the source collapses to one line.
  await dialog.getByLabel('YouTube link').fill('https://youtu.be/abcdefghijk');
  await expect(dialog.getByRole('button', { name: 'Change' })).toBeVisible();
  await expect(dialog.getByLabel('YouTube link')).toHaveCount(0);
  await expect(dialog.getByRole('radiogroup', { name: 'What to do' }).getByRole('radio')).toHaveCount(2);
  const summary = dialog.locator('.import-dialog__summary');
  await expect(summary).toContainText('59 min');
  await expect(summary).toContainText('≈ $0.12');
  await expect(dialog.locator('.import-dialog__warning, .import-dialog__error, .import-dialog__facts')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Transcribe' })).toBeEnabled();
  await page.screenshot({ path: path.join(shots, 'import-dialog-2-details.png') });

  await dialog.getByRole('button', { name: 'Change' }).click();
  await expect(dialog.getByLabel('YouTube link')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
