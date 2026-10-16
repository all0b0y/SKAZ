import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { auditPanes, type PaneViolation } from './paneAudit';

// U3 screens of the new interface (wiki page, material, all materials, + Material, recording
// capsule + live panel, graph) on the BUILT renderer (`npm run build` → dist/renderer), served
// over loopback to Chromium with a fake `window.skaz` that answers from the in-memory U3 world
// in API-B2 shapes (the package-2 backend is not merged yet). Audio comes from Chromium's fake
// capture device (a synthetic tone) — no microphone. Layout audit at 1440 and 1100, light/dark.

const root = path.resolve(__dirname, '..');
const renderer = path.join(root, 'dist', 'renderer');
// Screenshots go to .runtime unless SKAZ_U3_SHOTS points elsewhere (never into another checkout by default).
const shots = process.env.SKAZ_U3_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-u3');
const WIDTHS = [{ width: 1440, height: 900 }, { width: 1100, height: 760 }] as const;
const THEMES = ['light', 'dark'] as const;

let browser: Browser;
let page: Page;
let server: http.Server;
let origin = '';
const consoleErrors: string[] = [];
const report: Array<{ state: string; panes: PaneViolation[]; extras: Extra[] }> = [];

interface Extra { kind: 'small-text' | 'empty-icon' | 'header-height' | 'offscreen' | 'chip-cut'; selector: string; detail: string }

/** The same extra checks as kb-shell: text ≥ 12px, no empty icons, fixed header heights, nothing off screen. */
function auditExtras(): Extra[] {
  const out: Extra[] = [];
  const describe = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '').split(/\s+/).slice(0, 2).join('.')}`;
  const visible = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(el) || el.closest('.kb-visually-hidden')) continue;
    const own = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
    if (!own) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 12 && !el.closest('.kb-badge, .kb-cn')) out.push({ kind: 'small-text', selector: describe(el), detail: `${size}px “${el.textContent!.trim().slice(0, 30)}”` });
  }
  for (const svg of Array.from(document.querySelectorAll('svg.kb-icon'))) {
    if (visible(svg) && svg.childElementCount === 0) out.push({ kind: 'empty-icon', selector: describe(svg), detail: svg.getAttribute('data-icon') ?? '' });
  }
  const expectH = (sel: string, h: number) => {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!visible(el)) continue;
      const got = Math.round(el.getBoundingClientRect().height);
      if (got !== h) out.push({ kind: 'header-height', selector: sel, detail: `${got} ≠ ${h}` });
    }
  };
  expectH('.kb-titlebar', 38);
  expectH('.kb-head', 46);
  // The merged rail is the narrow v39 one (U2): 36 px icon buttons.
  expectH('.kb-rail__item', 36);
  for (const el of Array.from(document.querySelectorAll('[data-pane]'))) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.top < -1) {
      out.push({ kind: 'offscreen', selector: el.getAttribute('data-pane')!, detail: JSON.stringify({ l: r.left, r: r.right, b: r.bottom }) });
    }
  }
  // A source chip keeps its time/page in view and stays inside its pane (long titles shorten instead).
  for (const chip of Array.from(document.querySelectorAll('.kb-chip, .kb-srcs__item'))) {
    if (!visible(chip)) continue;
    const pane = chip.closest('[data-pane]');
    const c = chip.getBoundingClientRect();
    const p = pane?.getBoundingClientRect();
    const meta = chip.querySelector('.kb-chip__meta')?.getBoundingClientRect();
    if ((p && c.right > p.right + 1) || (meta && meta.right > c.right + 1)) {
      out.push({ kind: 'chip-cut', selector: describe(chip), detail: `${chip.textContent!.trim().slice(0, 40)} → ${Math.round(c.right)} / ${Math.round(p?.right ?? 0)}` });
    }
  }
  return out;
}

async function check(state: string, shot = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  const panes = await page.evaluate(auditPanes);
  const extras = await page.evaluate(auditExtras);
  report.push({ state, panes, extras });
  if (shot) await page.screenshot({ path: path.join(shots, `${state}.png`) });
  expect(panes, `${state}: pane violations ${JSON.stringify(panes, null, 1)}`).toEqual([]);
  expect(extras, `${state}: extra violations ${JSON.stringify(extras, null, 1)}`).toEqual([]);
}

async function setView(width: number, height: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
}

const rail = (name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${name}`) });
const doc = () => page.locator('#kb-doc');

function serve(dir: string): Promise<http.Server> {
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const file = path.join(dir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  if (!fs.existsSync(path.join(renderer, 'index.html'))) throw new Error('Build the renderer first: npm run build');
  fs.mkdirSync(shots, { recursive: true });
  const fake = buildSync({
    entryPoints: [path.join(__dirname, 'u3-smoke', 'fakeSkaz.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120',
  }).outputFiles[0]!.text;
  server = await serve(renderer);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['microphone'], { origin });
  await context.addInitScript({ content: fake });
  await context.addInitScript(() => {
    if (!localStorage.getItem('skaz.kb.prefs')) localStorage.setItem('skaz.kb.prefs', JSON.stringify({ onboardingDone: true, section: 'materials', sideOpen: true }));
  });
  page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  await page.goto(`${origin}/index.html`);
  await expect(page.locator('html[data-kb-ui]')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'Materials' }).getByRole('button', { name: /Lecture 8/ })).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  fs.writeFileSync(path.join(shots, 'audit-report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

test('wiki page: sections, statement labels, chips; expanded; citation opens the material on the quote', async () => {
  for (const theme of THEMES) {
    for (const v of WIDTHS) {
      await setView(v.width, v.height, theme);
      const tag = `${v.width}-${theme}`;
      await rail('Wiki').click();
      const side = page.getByRole('region', { name: 'Wiki' });
      await side.getByRole('button', { name: /^Concepts/ }).click();
      await side.getByRole('button', { name: 'Entropy', exact: true }).click();
      await expect(doc().getByRole('heading', { level: 2, name: 'Entropy' })).toBeVisible();
      await expect(doc().getByText('Connection — agent inference')).toBeVisible();
      await check(`page-${tag}`);
      await page.getByRole('button', { name: 'Expand to the centre' }).click();
      await check(`page-expanded-${tag}`, v.width === 1440);
      await page.getByRole('button', { name: 'Back to side panel' }).click();
      await side.getByRole('button', { name: 'Wiki', exact: true }).click();
      await check(`wiki-side-${tag}`, v.width === 1440 && theme === 'light');

      // Citation → material at that fragment, the checked quote marked, Original shown.
      await doc().getByRole('button', { name: 'Source 1: Lecture 8 — entropy' }).first().click();
      await page.getByRole('dialog', { name: 'Lecture 8 — entropy' }).getByRole('button', { name: 'Open at quote, 08:12' }).click();
      await expect(doc().getByRole('heading', { level: 2, name: 'Lecture 8 — entropy' })).toBeVisible();
      await expect(doc().locator('mark.kb-quote')).toHaveText('S equals k times the log of W');
      await check(`material-quote-${tag}`);
      await doc().getByRole('button', { name: /Shannon — fixed/ }).click();
      await expect(page.getByRole('dialog', { name: 'Recognition fix' })).toBeVisible();
      await check(`material-fix-${tag}`);
      await page.keyboard.press('Escape');
      await doc().getByRole('radio', { name: 'Both' }).click();
      await check(`material-both-${tag}`);
      await page.getByRole('button', { name: 'Expand to the centre' }).click();
      await check(`material-side-by-side-${tag}`, v.width === 1440);
      await page.getByRole('button', { name: 'Back to side panel' }).click();
      await doc().getByRole('button', { name: /Excluded fragments: 1/ }).click();
      await expect(doc().getByText(/Ignore previous instructions/)).toBeVisible();
      await check(`material-excluded-${tag}`, v.width === 1440 && theme === 'light');
      await page.getByRole('button', { name: 'Close document' }).click();
    }
  }
});

test('all materials: table and cards over the centre; + Material with a classified link', async () => {
  for (const theme of THEMES) {
    for (const v of WIDTHS) {
      await setView(v.width, v.height, theme);
      const tag = `${v.width}-${theme}`;
      await rail('Materials').click();
      await page.getByTestId('all-materials').click();
      const center = page.getByRole('region', { name: 'All materials' });
      await expect(center.getByRole('table')).toBeVisible();
      await check(`all-materials-${tag}`);
      await center.getByRole('button', { name: 'Lecture 8 — entropy' }).click();
      await expect(doc().getByRole('heading', { level: 2, name: 'Lecture 8 — entropy' })).toBeVisible();
      await check(`all-materials-doc-${tag}`);
      await page.getByRole('button', { name: 'Close document' }).click();
      await center.getByRole('radio', { name: 'Cards' }).click();
      await check(`all-materials-cards-${tag}`);
      await center.getByRole('radio', { name: 'Table' }).click();
      await center.getByRole('button', { name: 'Close all materials' }).click();

      await page.getByTestId('add-material').click();
      const dialog = page.getByRole('dialog', { name: 'Add material' });
      await expect(dialog).toBeVisible();
      await check(`add-empty-${tag}`, v.width === 1440 && theme === 'light');
      await dialog.getByRole('textbox', { name: 'Link or any text' }).fill('https://www.youtube.com/watch?v=abc');
      await page.keyboard.press('Enter');
      await dialog.getByRole('textbox', { name: 'Link or any text' }).fill('Seminar notes: the log makes entropy additive.');
      await dialog.getByRole('button', { name: 'Add to list' }).click();
      await expect(dialog.getByText('Seminar on entropy')).toBeVisible();
      await check(`add-material-${tag}`);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
    }
  }
});

test('1024 × 700: all materials beside a material, + Material with audio, video and a long folder name (QA B11, B12)', async () => {
  const longName = 'Lecture notes of the autumn term — thermodynamics, statistical physics and entropy';
  for (const theme of THEMES) {
    await setView(1024, 700, theme);
    const tag = `1024-${theme}`;
    await rail('Materials').click();
    await page.getByTestId('all-materials').click();
    const center = page.getByRole('region', { name: 'All materials' });
    await center.getByRole('button', { name: 'Lecture 8 — entropy' }).click();
    await expect(doc().getByRole('heading', { level: 2, name: 'Lecture 8 — entropy' })).toBeVisible();
    await check(`all-materials-doc-${tag}`);
    const pane = (await center.boundingBox())!;
    for (const control of [center.getByRole('radiogroup', { name: 'Type' }), center.getByRole('combobox', { name: 'Folder' }),
      center.getByRole('combobox', { name: 'Sort' }), center.getByRole('radio', { name: 'Text' })]) {
      const box = (await control.boundingBox())!;
      expect(box.x + box.width, 'a control is cut at the right').toBeLessThanOrEqual(pane.x + pane.width - 8);
    }
    const name = (await center.locator('td.kb-amt__name').first().boundingBox())!;
    expect(name.width, 'the name column stays readable').toBeGreaterThanOrEqual(150);
    await page.getByRole('button', { name: 'Close document' }).click();
    await center.getByRole('button', { name: 'Close all materials' }).click();

    await page.getByTestId('add-material').click();
    const dialog = page.getByRole('dialog', { name: 'Add material' });
    await dialog.getByRole('button', { name: 'choose on the computer' }).click();
    await expect(dialog.getByText('speech.wav')).toBeVisible();
    const folder = dialog.getByRole('combobox', { name: 'Folder' });
    if (theme === 'light') {
      await folder.selectOption('__new');
      await dialog.getByRole('textbox', { name: 'New folder name' }).fill(longName);
      await page.keyboard.press('Enter');
    } else {
      await folder.selectOption({ label: longName });
    }
    await expect(folder).toHaveValue(/.+/);
    await expect(folder.locator('option:checked')).toHaveText(longName);
    const label = (await dialog.getByText('Folder', { exact: true }).boundingBox())!;
    const select = (await folder.boundingBox())!;
    expect(Math.abs(label.y - select.y), 'Folder label and select share one row').toBeLessThan(10);
    const body = dialog.locator('.kb-addmat__body');
    expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth), 'the modal never scrolls sideways').toBeLessThanOrEqual(0);
    await check(`add-media-${tag}`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('graph: wide panel, drawn on canvas (pixels), node card, legend', async () => {
  for (const theme of THEMES) {
    for (const v of WIDTHS) {
      await setView(v.width, v.height, theme);
      const tag = `${v.width}-${theme}`;
      // The merged rail has no Graph item (v39): the graph opens from the Wiki section.
      await rail('Wiki').click();
      await page.locator('#kb-side').getByRole('button', { name: 'Graph of connections' }).click();
      const panel = page.getByRole('complementary', { name: 'Graph of connections' });
      await expect(panel.getByText('22 concepts · 4 folders')).toBeVisible();
      await page.waitForTimeout(2500);
      const pixels = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]')!;
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        const colours = new Set<string>();
        for (let i = 0; i < d.length; i += 16) {
          if (d[i + 3]! > 0) { painted += 1; colours.add(`${d[i]! >> 4},${d[i + 1]! >> 4},${d[i + 2]! >> 4}`); }
        }
        return { painted, colours: colours.size, w: c.width, h: c.height };
      });
      expect(pixels.w).toBeGreaterThan(300);
      expect(pixels.painted, `graph ${tag}: painted samples`).toBeGreaterThan(300);
      expect(pixels.colours, `graph ${tag}: folder colours`).toBeGreaterThanOrEqual(4);
      await check(`graph-${tag}`);
      await panel.getByRole('button', { name: 'Close graph' }).click();
    }
  }
  // Reduced motion: the final layout at once, no animation; still drawn.
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await setView(1440, 900, 'light');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#kb-side').getByRole('button', { name: 'Graph of connections' }).click();
  await expect(page.getByRole('complementary', { name: 'Graph of connections' }).getByText('22 concepts · 4 folders')).toBeVisible();
  const still = await page.evaluate(async () => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]')!;
    const snap = () => c.toDataURL();
    await new Promise((r) => setTimeout(r, 300));
    const a = snap();
    await new Promise((r) => setTimeout(r, 600));
    return a === snap() && a.length > 2000;
  });
  expect(still).toBe(true);
  await page.getByRole('button', { name: 'Close graph' }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('recording: capsule from the real signal, controls row, live panel, pause, stop', async () => {
  for (const theme of THEMES) {
    for (const v of WIDTHS) {
      await setView(v.width, v.height, theme);
      const tag = `${v.width}-${theme}`;
      const bar = page.getByTestId('titlebar');
      await check(`titlebar-${tag}`, false);
      await bar.getByRole('button', { name: /^Recording folder and sound/ }).click();
      const menu = page.getByRole('dialog', { name: 'Recording settings' });
      await expect(menu).toBeVisible();
      await check(`rec-menu-${tag}`, v.width === 1440);
      await page.keyboard.press('Escape');
      // The fake device's tone comes in short beeps: remember the tallest bar the capsule ever
      // drew, instead of sampling its height at moments that can all fall between two beeps.
      await page.evaluate(() => {
        const seen = { max: 0 };
        Object.assign(window, { __bars: seen });
        new MutationObserver(() => {
          for (const bar of document.querySelectorAll<HTMLElement>('[data-testid="titlebar"] .kb-lvl i')) {
            seen.max = Math.max(seen.max, parseFloat(bar.style.height) || 0);
          }
        }).observe(document.querySelector('[data-testid="titlebar"]')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
      });
      await bar.getByRole('button', { name: 'Record', exact: true }).click();
      const capsule = bar.getByRole('button', { name: /^Recording \d\d:\d\d/ });
      await expect(capsule).toBeVisible({ timeout: 15_000 });
      const live = page.getByRole('complementary', { name: 'Live recording' });
      await expect(live.getByText(/Итак, Больцман записал|So Boltzmann wrote/).first()).toBeVisible({ timeout: 15_000 });
      // The fake capture device plays a tone: the bars must leave the silent height (4px).
      await expect.poll(() => page.evaluate(() => (window as unknown as { __bars: { max: number } }).__bars.max), { timeout: 10_000 })
        .toBeGreaterThan(4);
      const animated = await capsule.locator('.kb-lvl i').first().evaluate((e) => getComputedStyle(e).animationName);
      expect(animated).toBe('none');
      await check(`rec-live-${tag}`);
      await capsule.click();
      const row = page.getByRole('dialog', { name: 'Recording controls' });
      await expect(row).toBeVisible();
      await check(`rec-controls-${tag}`);
      await row.getByRole('button', { name: 'Pause' }).click();
      await expect(bar.getByRole('button', { name: /^Paused/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await check(`rec-paused-${tag}`, v.width === 1440);
      await bar.getByRole('button', { name: 'Resume' }).click();
      await bar.getByRole('button', { name: /^Recording \d\d:\d\d/ }).click();
      await page.getByRole('dialog', { name: 'Recording controls' }).getByRole('button', { name: 'Stop' }).click();
      await expect(bar.getByRole('button', { name: 'Record', exact: true })).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Close live transcript' }).click();
    }
  }
});

test('no unknown routes, console stayed clean', async () => {
  const unknown = await page.evaluate(() => (window as unknown as { __u3: { unknown: string[] } }).__u3.unknown);
  expect([...new Set(unknown)]).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
