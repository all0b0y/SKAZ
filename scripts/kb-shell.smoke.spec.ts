import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';
import { auditPanes, type PaneViolation } from './paneAudit';

// New interface (frontend/src/kb), real built Electron app + real local backend, isolated
// profile. Layout audit of every U1 state: widths 1440/1024/960, light/dark, side panel
// open/collapsed, document panel closed/open/expanded, settings open, each first-launch step.
// Fixture materials are written by the backend's own Library code into the isolated Documents.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_KB_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-shell');
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

interface Extra { kind: 'small-text' | 'empty-icon' | 'header-height' | 'offscreen'; selector: string; detail: string }

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
    if (size < 12 && !el.closest('.kb-badge')) out.push({ kind: 'small-text', selector: describe(el), detail: `${size}px “${el.textContent!.trim().slice(0, 30)}”` });
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
  expectH('.kb-rail__item', 58);
  expectH('.kb-composer', 84);
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
  ({ app, close } = await launchIsolatedSmoke('skaz-kb-shell-'));
  profileDir = fs.realpathSync(await app.evaluate(({ app: main }) => main.getPath('userData')));
  page = await app.firstWindow();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase), { timeout: 60_000 }).toBe('ready');
  await page.evaluate(() => localStorage.setItem('skaz.ui', 'kb'));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  fs.writeFileSync(path.join(shots, 'audit-report.json'), JSON.stringify(report, null, 1));
  await close?.();
});

test('new interface is chosen by the flag; Inter and Unbounded are loaded locally', async () => {
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
  await expect(dialog.locator('li[data-tone="ok"]')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Open SKAZ' }).click();
  await expect(dialog).toHaveCount(0);
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
  await expect(page.getByRole('button', { name: /Notifications/ })).toContainText('2');

  for (const theme of THEMES) {
    for (const v of WIDTHS) {
      await setView(v.width, v.height, theme);
      const base: Record<string, number[]>[] = [];
      const record = async () => base.push(await page.evaluate(anchors));
      const tag = `${v.width}-${theme}`;

      // Side open, doc closed — each section.
      for (const section of ['Chats', 'Materials', 'Wiki', 'Graph', 'Notifications']) {
        await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${section}`) }).click();
        await check(`shell-${section.toLowerCase()}-${tag}`, section === 'Materials' || section === 'Chats' || section === 'Notifications');
        await record();
      }
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
        await dialog.getByRole('navigation').getByRole('button', { name: section, exact: true }).click();
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

test('console stayed clean', async () => {
  expect(consoleErrors).toEqual([]);
});
