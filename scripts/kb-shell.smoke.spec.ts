import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';
import { auditPanes, type PaneViolation } from './paneAudit';

// New interface (frontend/src/kb), real built Electron app + real local backend, isolated
// profile. Layout audit of every U1/U2 shell state: widths 1440/1024/960, light/dark, side panel
// open/collapsed, document panel closed/open/expanded, settings open, each first-launch step.
// Fixture materials are written by the backend's own Library code into the isolated Documents.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_KB_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-shell');
/** Key package-2 screens on the real backend (I1); the orchestrator copies them where it wants. */
const keyShots = process.env.SKAZ_I1_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-i1');
const WIDTHS = [
  { width: 1440, height: 860 },
  { width: 1024, height: 720 },
  { width: 960, height: 640 },
] as const;
const THEMES = ['light', 'dark'] as const;

let app: ElectronApplication;
let page: Page;
let close: () => Promise<void>;
let profileDir = '';
const consoleErrors: string[] = [];

interface Extra { kind: 'small-text' | 'empty-icon' | 'header-height' | 'offscreen' | 'chip-cut'; selector: string; detail: string }

/** Checks beyond paneAudit: text under 12px (counter digits excepted), empty icons, fixed header heights. */
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
    // SVG text is scaled with its viewBox: measure the rendered glyph height instead.
    if (el instanceof SVGTextElement) {
      const h = el.getBoundingClientRect().height;
      if (h < 12) out.push({ kind: 'small-text', selector: describe(el), detail: `svg text box ${h.toFixed(1)}px` });
      continue;
    }
    // Counter digits (rail badge, "Decide" count) and source footnote numbers (v42) are the only text under 12px.
    if (size < 12 && !el.closest('.kb-badge, .kb-count, .kb-cn')) out.push({ kind: 'small-text', selector: describe(el), detail: `${size}px “${el.textContent!.trim().slice(0, 30)}”` });
  }
  for (const svg of Array.from(document.querySelectorAll('svg.kb-icon'))) {
    if (!visible(svg)) continue;
    if (svg.childElementCount === 0) out.push({ kind: 'empty-icon', selector: describe(svg), detail: svg.getAttribute('data-icon') ?? '' });
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
  // Rail of the v39 summary: 36px icon buttons. The message field grows with its text, so its
  // height is checked as "unchanged between states" by anchors() instead of a fixed number.
  expectH('.kb-rail__item', 36);
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
  for (const el of Array.from(document.querySelectorAll('[data-pane]'))) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.top < -1) {
      out.push({ kind: 'offscreen', selector: el.getAttribute('data-pane')!, detail: JSON.stringify({ l: r.left, r: r.right, b: r.bottom }) });
    }
  }
  return out;
}

/** Positions that must not move between states: rail items and the composer. */
function anchors(): Record<string, number[]> {
  const box = (el: Element | null) => {
    if (!el) return [];
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  const out: Record<string, number[]> = {};
  for (const el of Array.from(document.querySelectorAll('.kb-rail [data-section] .kb-rail__icon'))) {
    out[`rail:${el.closest('[data-section]')!.getAttribute('data-section')}`] = box(el);
  }
  const composer = document.querySelector('.kb-composer');
  if (composer && !composer.closest('[hidden]')) {
    const r = composer.getBoundingClientRect();
    out.composer = [Math.round(r.bottom), Math.round(r.height)];
  }
  return out;
}

const report: Array<{ state: string; panes: PaneViolation[]; extras: Extra[] }> = [];

async function settle() {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

async function check(state: string, shot = true) {
  await settle();
  const panes = await page.evaluate(auditPanes);
  const extras = await page.evaluate(auditExtras);
  report.push({ state, panes, extras });
  if (shot) await page.screenshot({ path: path.join(shots, `${state}.png`) });
  expect(panes, `${state}: pane violations ${JSON.stringify(panes, null, 1)}`).toEqual([]);
  expect(extras, `${state}: extra violations ${JSON.stringify(extras, null, 1)}`).toEqual([]);
}

/** Audit a package-2 screen; its screenshot goes with the key screens. */
async function checkKey(state: string) {
  await check(state, false);
  await page.screenshot({ path: path.join(keyShots, `${state}.png`) });
}

/** A request through the real preload bridge and IPC policy, as the renderer makes it. */
async function bridgeRequest<T>(method: string, reqPath: string): Promise<{ ok: boolean; status: number; data?: T; detail?: string }> {
  return page.evaluate(({ m, p }) => window.skaz.request({ method: m as 'GET', path: p }), { m: method, p: reqPath }) as never;
}

async function setView(width: number, height: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
}

function seedMaterials() {
  const libRoot = path.join(profileDir, 'Documents', 'SKAZ');
  const script = `
import sys
from pathlib import Path
from skaz.knowledge.library.library import Library
from skaz.knowledge.markdown.source import FragmentInput
lib = Library.open(Path(sys.argv[1]), None)
inbox = next(f for f in lib.folders() if f.system)
phys = lib.create_folder("Physics")
ml = lib.create_folder("Machine learning — a folder with a long name for the side panel")
lib.create_material(phys.id, "Lecture 8 — entropy and the second law of thermodynamics, part one", "recording", [
    FragmentInput("Boltzmann wrote entropy as S equals k times the logarithm of W.", start_ms=492000, end_ms=500000, speaker="Speaker 1"),
    FragmentInput("Why a logarithm? Because entropies of two independent systems should add up.", start_ms=640000, end_ms=650000, speaker="Speaker 1"),
], languages=["en"])
lib.create_material(phys.id, "Textbook — Information theory, ch. 2", "pdf", [FragmentInput("Entropy H = −Σ p log p.", page=31)], languages=["en"])
lib.create_material(ml.id, "Cross-entropy explained", "web", [FragmentInput("Cross-entropy is entropy applied to model error.", index=0)], languages=["en"])
lib.create_material(inbox.id, "Pasted text — problems", "text", [FragmentInput("Problem 1. Compute the entropy of a fair die.", index=0)], languages=["en"])
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.repositories import NotificationRepository
db = KnowledgeDatabase(Path(sys.argv[2]) / "knowledge.sqlite3")
NotificationRepository(db).add("conflict", "Conflict in “Entropy”", requires_action=True)
NotificationRepository(db).add("note_ready", "Note ready: Lecture 8")
`;
  const res = spawnSync(path.join(root, 'backend/.venv/bin/python'), ['-c', script, libRoot, path.join(profileDir, 'data')], {
    cwd: path.join(root, 'backend'), env: { ...process.env, PYTHONPATH: path.join(root, 'backend/src') }, encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`fixture failed: ${res.stderr}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(keyShots, { recursive: true });
  ({ app, close } = await launchIsolatedSmoke('skaz-kb-shell-'));
  profileDir = fs.realpathSync(await app.evaluate(({ app: main }) => main.getPath('userData')));
  page = await app.firstWindow();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase), { timeout: 60_000 }).toBe('ready');
});

test.afterAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  fs.writeFileSync(path.join(shots, 'audit-report.json'), JSON.stringify(report, null, 1));
  await close?.();
});

test('the Knowledge Wiki interface starts by default; Inter and Unbounded are loaded locally', async () => {
  await expect(page.locator('html[data-kb-ui]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: 'Welcome to SKAZ' })).toBeVisible({ timeout: 30_000 });
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    // Loading by request proves the local files pass the CSP (font-src 'self'), Latin and Cyrillic.
    const load = async (font: string, text: string) => (await document.fonts.load(font, text)).length > 0;
    return {
      inter: await load('600 14px "SKAZ Inter"', 'Aa Ая') && document.fonts.check('600 14px "SKAZ Inter"', 'Aa Ая'),
      unbounded: await load('700 20px "SKAZ Unbounded"', 'Aa Ая') && document.fonts.check('700 20px "SKAZ Unbounded"', 'Aa Ая'),
      loaded: Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`),
    };
  });
  expect(fonts.inter).toBe(true);
  expect(fonts.unbounded).toBe(true);
  expect(fonts.loaded.some((f) => f.includes('SKAZ Inter'))).toBe(true);
  expect(fonts.loaded.some((f) => f.includes('SKAZ Unbounded'))).toBe(true);
});

test('first launch: every step at every width and theme', async () => {
  const dialog = page.getByRole('dialog', { name: 'Welcome to SKAZ' });
  const steps = ['lang', 'agent', 'speech', 'library', 'summary'] as const;
  for (const step of steps) {
    for (const theme of THEMES) {
      for (const v of WIDTHS) {
        await setView(v.width, v.height, theme);
        await check(`ob-${step}-${v.width}-${theme}`, v.width !== 1024);
      }
    }
    if (step === 'lang') {
      await dialog.getByRole('button', { name: 'Russian' }).click();
      await dialog.getByRole('button', { name: 'English' }).click();
      await dialog.getByRole('button', { name: 'Next' }).click();
    } else if (step === 'agent' || step === 'speech') {
      await dialog.getByRole('button', { name: 'Skip' }).click();
    } else if (step === 'library') {
      await dialog.getByRole('button', { name: 'Create library' }).click();
      await expect(dialog.getByRole('heading', { name: 'Ready to start' })).toBeVisible();
    }
  }
  // Only the library is surely ready here; agents and speech report whatever this Mac really has.
  await expect(dialog.locator('li[data-tone="ok"]', { hasText: 'Library' })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Open SKAZ' }).click();
  await expect(dialog).toHaveCount(0);

  // QA A1: the ACTIVE rail item's name slides out painted like the others — read the real pixels
  // of the window (not the DOM) beyond the 36px square, where only the name pill can be.
  await setView(1440, 860, 'light');
  const active = page.locator('button.kb-rail__item.is-active');
  await active.hover();
  const label = active.getByTestId('rail-label');
  await expect(label).toBeVisible();
  await page.waitForTimeout(400);
  const box = (await label.boundingBox())!;
  const fill = (await label.evaluate((el) => getComputedStyle(el).backgroundColor)).match(/\d+/g)!.slice(0, 3).map(Number);
  const pixel = await app.evaluate(async ({ BrowserWindow }, at) => {
    const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage({ x: at.x, y: at.y, width: 1, height: 1 });
    const [b, g, r] = image.toBitmap();
    return [r!, g!, b!];
  }, { x: Math.round(box.x + box.width - 8), y: Math.round(box.y + box.height / 2) });
  // Colour management may move a channel by a step or two; the side panel behind is far lighter.
  expect(Math.max(...pixel.map((c, i) => Math.abs(c - fill[i]!))), `the name pill of the active rail item is painted: ${pixel} vs ${fill}`).toBeLessThan(8);
  await page.mouse.move(700, 500);
});

test('reduced motion: first-launch art is a still frame', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('skaz.kb.prefs') ?? '{}');
    localStorage.setItem('skaz.kb.prefs', JSON.stringify({ ...raw, onboardingDone: false }));
  });
  await page.reload();
  const art = page.locator('[data-art="lang"]');
  await expect(art).toHaveAttribute('data-still', 'true', { timeout: 30_000 });
  await page.screenshot({ path: path.join(shots, 'ob-lang-reduced-motion.png') });
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('skaz.kb.prefs') ?? '{}');
    localStorage.setItem('skaz.kb.prefs', JSON.stringify({ ...raw, onboardingDone: true }));
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('shell: side panel and document panel states keep headers, rail and composer in place', async () => {
  seedMaterials();
  await page.evaluate(() => window.skaz.request({ method: 'POST', path: '/kb/library/retry' }));
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('skaz.kb.prefs') ?? '{}');
    localStorage.setItem('skaz.kb.prefs', JSON.stringify({ ...raw, section: 'materials', sideOpen: true }));
  });
  await page.reload();
  const side = page.getByRole('region', { name: 'Materials' });
  await expect(side.getByRole('button', { name: /Lecture 8/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Notifications/ })).toContainText(/\d/);

  for (const theme of THEMES) {
    for (const v of WIDTHS) {
      await setView(v.width, v.height, theme);
      const base: Record<string, number[]>[] = [];
      const record = async () => base.push(await page.evaluate(anchors));
      const tag = `${v.width}-${theme}`;

      // Side open, doc closed — each section.
      for (const section of ['Chats', 'Materials', 'Wiki', 'Notifications']) {
        await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${section}`) }).click();
        await check(`shell-${section.toLowerCase()}-${tag}`, section === 'Materials' || section === 'Chats' || section === 'Notifications');
        await record();
      }
      // The graph is reached from the Wiki section (v39), not from the rail.
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Wiki/ }).click();
      await page.getByRole('region', { name: 'Wiki' }).getByRole('button', { name: 'Graph of connections' }).click();
      await check(`shell-graph-${tag}`, false);
      await record();
      // Doc open.
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Materials/ }).click();
      await page.getByRole('region', { name: 'Materials' }).getByRole('button', { name: /Lecture 8/ }).click();
      await expect(page.getByRole('complementary', { name: 'Document' }).getByRole('heading', { level: 2 })).toBeVisible();
      await check(`shell-doc-open-${tag}`);
      await record();
      // Doc expanded.
      await page.getByRole('button', { name: 'Expand to the centre' }).click();
      await check(`shell-doc-expanded-${tag}`);
      const expandedAnchors = await page.evaluate(anchors);
      await page.getByRole('button', { name: 'Back to side panel' }).click();
      // Side collapsed, doc open, then doc closed.
      await page.getByRole('button', { name: 'Hide side panel' }).click();
      await check(`shell-collapsed-doc-${tag}`);
      await record();
      await page.getByRole('button', { name: 'Close document' }).click();
      await check(`shell-collapsed-${tag}`);
      await record();
      // Folder view and the folder menu.
      await page.getByRole('button', { name: 'Show side panel' }).click();
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Materials/ }).click();
      await page.getByRole('region', { name: 'Materials' }).getByRole('button', { name: /^Machine learning/ }).click();
      await check(`shell-folder-${tag}`, v.width === 960);
      await page.getByRole('button', { name: 'All folders' }).click();

      // Nothing moved: rail icons identical in every state; composer bottom identical where shown.
      for (const a of [...base, expandedAnchors]) {
        for (const [k, box] of Object.entries(a)) {
          if (k.startsWith('rail:')) expect(box, `${tag} ${k}`).toEqual(base[0]![k]);
        }
      }
      for (const a of base) expect(a.composer, `${tag} composer`).toEqual(base[0]!.composer);
    }
  }
});

test('settings: every section at every width and theme', async () => {
  for (const theme of THEMES) {
    for (const v of WIDTHS) {
      await setView(v.width, v.height, theme);
      await page.keyboard.press('Meta+Comma');
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await expect(dialog).toBeVisible();
      for (const section of ['Accounts & keys', 'Models', 'Recording & speech', 'Wiki', 'Storage', 'Privacy', 'Appearance', 'About']) {
        // A section with a problem on this Mac is named "<section> Needs attention" (the dot).
        await dialog.getByRole('navigation').getByRole('button', { name: new RegExp(`^${section}`) }).click();
        const shot = (section === 'Storage' || section === 'Models' || section === 'Appearance') && v.width !== 1024;
        await check(`settings-${section.replace(/\W+/g, '-').toLowerCase()}-${v.width}-${theme}`, shot);
      }
      await dialog.getByRole('searchbox', { name: 'Find a setting' }).fill('model');
      await check(`settings-search-${v.width}-${theme}`, v.width === 1440);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  }
});

test('folder create with a name collision shows the backend reason in place', async () => {
  await setView(1440, 860, 'light');
  const side = page.getByRole('region', { name: 'Materials' });
  await side.getByRole('button', { name: 'New folder' }).click();
  await side.getByRole('textbox', { name: 'New folder name' }).fill('physics');
  await page.keyboard.press('Enter');
  await expect(side.getByRole('alert')).toContainText('already exists');
  await check('shell-folder-collision-1440-light');
  await page.keyboard.press('Escape');
});

/** A concept page written by the backend's own Library code (no model): one claim citing Lecture 8. */
function seedPage(materialId: string, folderId: string) {
  const libRoot = path.join(profileDir, 'Documents', 'SKAZ');
  const script = `
import sys
from pathlib import Path
from skaz.knowledge.library.library import Library
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
lib = Library.open(Path(sys.argv[1]), None)
lib.create_page(PageDocument(
    meta=PageMeta(skaz_id="pg-entropy", kind="concept", title="Entropy", language="en", sources=(sys.argv[2],), folders=(sys.argv[3],)),
    parts=[
        Block.create("c-e1", "from_source", "Entropy grows with the number of microstates W: S = k·ln W.",
                     cites=(Cite(sys.argv[2], 1, "S equals k times the logarithm of W"),)),
        Block.create("c-e2", "explanation", "The logarithm makes the entropies of independent systems add up."),
    ],
))
`;
  const res = spawnSync(path.join(root, 'backend/.venv/bin/python'), ['-c', script, libRoot, materialId, folderId], {
    cwd: path.join(root, 'backend'), env: { ...process.env, PYTHONPATH: path.join(root, 'backend/src') }, encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`page fixture failed: ${res.stderr}`);
}

test('package 2 on the real backend: chats, notifications, ⌘K, all materials, + Material, graph, wiki page, settings health', async () => {
  test.setTimeout(240_000);
  const rail = (name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${name}`) });
  const doc = () => page.getByRole('complementary', { name: 'Document' });
  const notFound = () => page.getByText(/Not Found/);
  await page.getByRole('button', { name: 'Show side panel' }).click().catch(() => undefined);

  // Every live read of the package-2 screens answers on this backend (no 404 behind a screen).
  for (const route of ['/kb/chats', '/kb/chats/events', '/kb/notifications', '/kb/agents', '/kb/settings/health', '/kb/settings/keys',
    '/kb/settings/speech', '/kb/settings/wiki', '/kb/settings/privacy', '/kb/settings/about', '/kb/decisions', '/kb/graph', '/kb/wiki/pages', '/kb/jobs']) {
    const res = await bridgeRequest('GET', route);
    expect(res, `GET ${route}`).toMatchObject({ ok: true });
  }

  let added = false;
  for (const theme of THEMES) {
    await setView(1440, 860, theme);
    const tag = `1440-${theme}`;

    // Chats: an empty list, the honest empty state, no "Not Found".
    await rail('Chats').click();
    await expect(page.getByRole('region', { name: 'Chats' }).getByText('No chats yet')).toBeVisible();
    await expect(notFound()).toHaveCount(0);
    await checkKey(`p2-chats-empty-${tag}`);

    // Notifications: the feed reads the real KbNotificationFeed.
    await rail('Notifications').click();
    const feed = page.getByRole('region', { name: 'Notifications' });
    await expect(feed.getByText(/Conflict in “Entropy”/)).toBeVisible();
    await expect(feed.getByText(/Note ready: Lecture 8/)).toBeVisible();
    await checkKey(`p2-notifications-${tag}`);

    // ⌘K over the real /kb/search + /kb/chats?q=.
    await page.keyboard.press('Meta+k');
    const search = page.getByRole('dialog', { name: 'Search' });
    await expect(search).toBeVisible();
    await search.getByRole('combobox').fill('entropy');
    await expect(search.getByRole('option').filter({ hasText: /Lecture 8/ }).first()).toBeVisible();
    await expect(search.getByRole('tab', { name: /Materials/ })).toContainText(/\d/);
    await checkKey(`p2-search-${tag}`);
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);

    // All materials over the centre.
    await rail('Materials').click();
    await page.getByRole('region', { name: 'Materials' }).getByRole('button', { name: /^All materials/ }).click();
    const all = page.getByRole('region', { name: 'All materials' });
    await expect(all.getByText('Cross-entropy explained')).toBeVisible();
    await checkKey(`p2-all-materials-${tag}`);
    await all.getByRole('button', { name: 'Close all materials' }).click();

    // + Material: pasted text, wiki left off (no model runs), then it opens on the right.
    if (!added) {
      await page.getByTestId('add-material').click();
      const dialog = page.getByTestId('add-material-dialog');
      await dialog.getByRole('textbox', { name: 'Link or any text' }).fill('Seminar notes: the logarithm makes entropy additive.');
      await dialog.getByRole('button', { name: 'Add to list' }).click();
      const wiki = dialog.getByRole('switch', { name: 'Add to wiki after processing' });
      if ((await wiki.getAttribute('aria-checked')) === 'true') await wiki.click();
      await expect(wiki).toHaveAttribute('aria-checked', 'false');
      await checkKey(`p2-add-material-${tag}`);
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      added = true;
    }
    await rail('Materials').click();
    await page.getByRole('region', { name: 'Materials' }).getByRole('button', { name: /Seminar notes/ }).first().click();
    await expect(doc().getByText('Seminar notes: the logarithm makes entropy additive.')).toBeVisible();
    await expect(doc().getByRole('heading', { level: 2 })).toContainText('Seminar notes');
    await checkKey(`p2-material-text-${tag}`);
    await doc().getByRole('button', { name: /^Close/ }).click();

    // Graph of an empty wiki: the honest empty state in the wide panel.
    await rail('Wiki').click();
    const wikiSide = page.getByRole('region', { name: 'Wiki' });
    if (theme === 'light') await expect(wikiSide.getByText('The wiki is empty')).toBeVisible();
    await wikiSide.getByRole('button', { name: 'Graph of connections' }).click();
    const graph = page.getByRole('complementary', { name: 'Graph of connections' });
    if (theme === 'light') await expect(graph.getByText('No connections yet')).toBeVisible();
    await checkKey(`p2-graph-${theme === 'light' ? 'empty' : 'one'}-${tag}`);
    await graph.getByRole('button', { name: 'Close graph' }).click();

    // A wiki page written to disk by the Library (no model), picked up by the backend's watcher.
    if (theme === 'light') {
      const list = await bridgeRequest<Array<{ id: string; title: string; folder_id: string }>>('GET', '/kb/materials');
      const lecture = list.data!.find((m) => m.title.startsWith('Lecture 8'))!;
      seedPage(lecture.id, lecture.folder_id);
      await expect.poll(async () => (await bridgeRequest<unknown[]>('GET', '/kb/wiki/pages')).data?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      await page.reload();
      await rail('Wiki').click();
    }
    await page.getByRole('region', { name: 'Wiki' }).getByRole('button', { name: /^Concepts/ }).click();
    await page.getByRole('region', { name: 'Wiki' }).getByRole('button', { name: 'Entropy' }).click();
    await expect(doc().getByRole('heading', { level: 2, name: 'Entropy' })).toBeVisible();
    await expect(doc().getByText('Entropy grows with the number of microstates W: S = k·ln W.')).toBeVisible();
    await expect(doc().getByText('Agent explanation')).toBeVisible();
    await expect(doc().getByText(/1 folder · 1 source/)).toBeVisible();
    await checkKey(`p2-wiki-page-${tag}`);
    // The claim's source number opens a popup; "Open at quote/fragment" opens the material there.
    await doc().getByRole('button', { name: /^Source \d+: Lecture 8/ }).first().click();
    await page.getByRole('dialog', { name: /Lecture 8/ }).getByRole('button', { name: /^Open at (quote|fragment)/ }).first().click();
    await expect(doc().getByRole('heading', { level: 2 })).toContainText('Lecture 8');
    await expect(doc().locator('.is-target').first()).toBeVisible();
    await checkKey(`p2-citation-material-${tag}`);
    await doc().getByRole('button', { name: /^Close/ }).click();

    // Settings: health on the gear and in the sections; every live row read without an error.
    const health = await bridgeRequest<{ sections: Array<{ id: string }> }>('GET', '/kb/settings/health');
    expect(health.data!.sections.length).toBeGreaterThan(0);
    await page.keyboard.press('Meta+Comma');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    for (const section of ['Accounts & keys', 'Models', 'Recording & speech', 'Wiki', 'Privacy', 'About']) {
      await settings.getByRole('navigation').getByRole('button', { name: new RegExp(`^${section}`) }).click();
      await page.waitForTimeout(300);
      await expect(settings.getByText(/Couldn’t read/), `${section}: a live row failed to read`).toHaveCount(0);
      await expect(settings.getByText(/Not Found/)).toHaveCount(0);
      if (section === 'Accounts & keys' || section === 'Models') await checkKey(`p2-settings-${section.replace(/\W+/g, '-').toLowerCase()}-${tag}`);
    }
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
  }
});

test('console stayed clean', async () => {
  expect(consoleErrors).toEqual([]);
});
