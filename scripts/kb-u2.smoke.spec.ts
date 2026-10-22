import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { auditPanes, type PaneViolation } from './paneAudit';

// U2 (package 2 interface) in a real browser on the shared fake backend (frontend/src/kb/test/
// browserFake.ts — the same fixtures as the component tests, in the API-B2 shapes). The package-2
// backend is written in parallel, so this smoke proves layout and behaviour against the contract;
// kb-shell.smoke.spec.ts keeps covering the real Electron app with the real backend.
// States of the v39 summary at 1440 and 1100, light and dark: layout audit 0, console clean.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_U2_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-u2');
const VIEWS = [
  { width: 1440, height: 860 },
  { width: 1100, height: 760 },
] as const;
const THEMES = ['light', 'dark'] as const;

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

interface Extra { kind: 'small-text' | 'empty-icon' | 'header-height' | 'offscreen' | 'chip-cut'; selector: string; detail: string }

/** Text under 12px (counter digits excepted), empty icons, fixed chrome heights, nothing off screen. */
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
    if (!visible(el) || el.closest('.kb-visually-hidden') || el instanceof SVGElement) continue;
    const own = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
    if (!own) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 12 && !el.closest('.kb-badge, .kb-count, .kb-cn')) out.push({ kind: 'small-text', selector: describe(el), detail: `${size}px “${el.textContent!.trim().slice(0, 30)}”` });
  }
  // Static Lucide icons are `svg.kb-icon`; animated-icons glyphs are a `div.kb-icon--lib` around their svg.
  for (const svg of Array.from(document.querySelectorAll('svg.kb-icon, .kb-icon--lib > svg'))) {
    if (visible(svg) && svg.childElementCount === 0) out.push({ kind: 'empty-icon', selector: describe(svg), detail: svg.closest('[data-icon]')?.getAttribute('data-icon') ?? '' });
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
  expectH('.kb-rail__item', 36);
  for (const el of Array.from(document.querySelectorAll('[data-pane], .kb-popover, .kb-modal, .kb-mentions, .kb-selbar'))) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.top < -1) {
      out.push({ kind: 'offscreen', selector: describe(el), detail: JSON.stringify({ l: r.left, r: r.right, t: r.top, b: r.bottom }) });
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

/** Rail icons: must not move between states. */
function railAnchors(): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const el of Array.from(document.querySelectorAll('.kb-rail [data-section] .kb-rail__icon'))) {
    const r = el.getBoundingClientRect();
    out[el.closest('[data-section]')!.getAttribute('data-section')!] = [Math.round(r.left), Math.round(r.top)];
  }
  return out;
}

const report: Array<{ state: string; panes: PaneViolation[]; extras: Extra[] }> = [];
let railBase: Record<string, number[]> | null = null;

async function check(state: string) {
  // No hover tooltip left over from the last click in the picture.
  await page.mouse.move(2, 300);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const panes = await page.evaluate(auditPanes);
  const extras = await page.evaluate(auditExtras);
  report.push({ state, panes, extras });
  await page.screenshot({ path: path.join(shots, `${state}.png`) });
  expect(panes, `${state}: pane violations ${JSON.stringify(panes, null, 1)}`).toEqual([]);
  expect(extras, `${state}: extra violations ${JSON.stringify(extras, null, 1)}`).toEqual([]);
  const rail = await page.evaluate(railAnchors);
  if (Object.keys(rail).length) {
    railBase ??= rail;
    expect(rail, `${state}: the rail moved`).toEqual(railBase);
  }
}

async function open(query = '', theme: 'light' | 'dark' = 'light', view: { width: number; height: number } = VIEWS[0]) {
  await page.setViewportSize(view);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${base}/src/kb/test/harness.html${query}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/src/kb/test/harness.html${query}`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
  railBase = null;
}

const side = () => page.getByRole('region', { name: 'Chats' });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  info.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  server = await createServer({
    configFile: false,
    root: path.join(root, 'frontend'),
    plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'frontend/src') } },
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer!.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  browser = await chromium.launch();
  page = await browser.newPage({ deviceScaleFactor: 2 });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
});

test.afterAll(async () => {
  fs.writeFileSync(path.join(shots, 'audit-report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await server?.close();
});

for (const theme of THEMES) {
  for (const view of VIEWS) {
    const tag = `${view.width}-${theme}`;

    test(`chat with a connection, source number on the right — ${tag}`, async () => {
      await open('', theme, view);
      await side().getByRole('button', { name: /Why is there a logarithm/ }).click();
      const answer = page.getByRole('article', { name: 'Answer' });
      await answer.getByRole('button', { name: /Connection · 3 folders/ }).click();
      await expect(answer.getByText('Agent inference:')).toBeVisible();
      await check(`chat-${tag}`);
      await answer.getByRole('button', { name: 'Source 1: Lecture 5' }).first().click();
      const pop = page.getByRole('dialog', { name: 'Lecture 5' });
      await expect(pop.getByText('44:00')).toBeVisible();
      await check(`chat-source-${tag}`);
      await pop.getByRole('button', { name: /^Open at fragment/ }).click();
      await expect(page.getByRole('complementary', { name: 'Document' }).getByRole('heading', { level: 2 })).toBeVisible();
      await check(`chat-doc-${tag}`);
    });

    test(`@ mention popup and agent picker — ${tag}`, async () => {
      await open('', theme, view);
      await side().getByRole('button', { name: /Why is there a logarithm/ }).click();
      const input = page.getByTestId('message-input');
      await input.click();
      await page.keyboard.type('and how does it relate to @entr');
      await expect(page.getByTestId('mention-popup').getByRole('option').first()).toBeVisible();
      await check(`at-${tag}`);
      await page.keyboard.press('Enter');
      await expect(input.locator('.kb-token--mention')).toHaveText('Entropy');
      await page.getByTestId('agent-picker').click();
      await expect(page.getByRole('menu', { name: 'Agent and model' })).toBeVisible();
      await check(`engine-${tag}`);
      await page.getByRole('menuitemradio', { name: 'GPT-5.6-luna', exact: true }).click();
      await expect(page.getByText('Switched to Codex')).toBeVisible();
      await check(`engine-switched-${tag}`);
    });

    test(`answering, then interrupted by a limit — ${tag}`, async () => {
      await open('?hold=1', theme, view);
      await expect(side().getByRole('button', { name: /What did I miss/ })).toBeVisible();
      await page.getByTestId('message-input').click();
      await page.keyboard.type('hit the limit');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Stop the answer' })).toBeVisible();
      await check(`answering-${tag}`);
      await page.evaluate(() => {
        const fake = (window as unknown as { __kbFake: { finish: (id: string) => void; services: { chats: { getState: () => { currentId: string } } } } }).__kbFake;
        fake.finish(fake.services.chats.getState().currentId);
      });
      await expect(page.getByText('Answer interrupted: subscription limit')).toBeVisible({ timeout: 10_000 });
      await check(`limit-${tag}`);
    });

    test(`⌘K search — ${tag}`, async () => {
      await open('', theme, view);
      await page.keyboard.press('Meta+k');
      const dialog = page.getByRole('dialog', { name: 'Search' });
      await expect(dialog).toBeVisible();
      await page.keyboard.type('entropy');
      await expect(dialog.getByRole('option').nth(2)).toBeVisible();
      await check(`search-${tag}`);
      await page.keyboard.press('Escape');
    });

    test(`notifications feed and decision windows — ${tag}`, async () => {
      await open('', theme, view);
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Notifications/ }).click();
      const feed = page.getByRole('region', { name: 'Notifications' });
      await expect(feed.getByText('Sources disagree in “Entropy”')).toBeVisible();
      await check(`notif-${tag}`);
      await feed.getByRole('button', { name: 'Needs a decision: Sources disagree in “Entropy”' }).click();
      await expect(page.getByRole('dialog', { name: 'Sources disagree in “Entropy”' })).toBeVisible();
      await check(`decision-discrepancy-${tag}`);
      await page.getByRole('button', { name: 'Next decision' }).click();
      await expect(page.getByText('confidence 54%')).toBeVisible();
      await check(`decision-corrections-${tag}`);
      await page.getByRole('button', { name: 'Next decision' }).click();
      await page.getByRole('button', { name: 'Fix address' }).click();
      await check(`decision-link-${tag}`);
      await page.getByRole('button', { name: 'Next decision' }).click();
      await expect(page.getByText('Not an instruction, restore')).toBeVisible();
      await check(`decision-excluded-${tag}`);
      await page.keyboard.press('Escape');
    });

    test(`all chats over the centre — ${tag}`, async () => {
      await open('', theme, view);
      await side().getByRole('button', { name: /^All chats/ }).click();
      await expect(page.getByRole('region', { name: 'All chats' }).getByRole('button', { name: /^Transformer paper review/ })).toBeVisible();
      await check(`allchats-${tag}`);
    });

    test(`settings: live sections — ${tag}`, async () => {
      await open('', theme, view);
      // The gear with a dot opens the section that needs attention.
      await page.getByRole('button', { name: 'Settings, needs attention' }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await expect(dialog.getByText('Hermes Agent isn’t installed.').first()).toBeVisible();
      for (const section of ['Accounts & keys', 'Models', 'Recording & speech', 'Wiki', 'Privacy', 'About']) {
        await dialog.getByRole('navigation').getByRole('button', { name: new RegExp(`^${section.replace(/[&]/g, '.')}`) }).click();
        await page.waitForTimeout(150);
        await check(`settings-${section.replace(/\W+/g, '-').toLowerCase()}-${tag}`);
      }
      await page.keyboard.press('Escape');
    });

    test(`settings: consent to send audio to Soniox — ${tag}`, async () => {
      await open('?soniox=off', theme, view);
      await page.getByRole('button', { name: 'Settings, needs attention' }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await dialog.getByRole('navigation').getByRole('button', { name: /^Recording . speech/ }).click();
      const plate = dialog.locator('.kb-banner', { hasText: 'Sending audio to Soniox is off' });
      await expect(plate).toBeVisible();
      const consent = dialog.getByRole('switch', { name: 'Send audio to Soniox' });
      await expect(consent).toHaveAttribute('aria-checked', 'false');
      await check(`settings-soniox-consent-off-${tag}`);
      await plate.getByRole('button', { name: 'Allow sending audio to Soniox' }).click();
      await expect(plate).toHaveCount(0);
      await expect(consent).toHaveAttribute('aria-checked', 'true');
      await check(`settings-soniox-consent-on-${tag}`);
      await page.keyboard.press('Escape');
    });

    test(`first launch: Agent step — ${tag}`, async () => {
      await open('?onboarding=1', theme, view);
      const dialog = page.getByRole('dialog', { name: 'Welcome to SKAZ' });
      await dialog.getByRole('button', { name: 'Next' }).click();
      await expect(dialog.getByText('Not installed')).toBeVisible();
      await check(`ob-agent-${tag}`);
      await dialog.locator('[data-engine="hermes"]').getByRole('button', { name: 'Install' }).click();
      await expect(dialog.getByLabel('Install log')).toContainText('Downloading Hermes Agent');
      await check(`ob-agent-installing-${tag}`);
    });
  }
}

test('narrow centre hides the effort (v39)', async () => {
  await open('', 'light', { width: 960, height: 700 });
  await side().getByRole('button', { name: /Why is there a logarithm/ }).click();
  await page.getByRole('article', { name: 'Answer' }).getByRole('button', { name: 'Wiki page: Entropy' }).first().click();
  await expect(page.getByRole('complementary', { name: 'Document' })).toBeVisible();
  const width = await page.locator('.kb-composer').evaluate((el) => el.getBoundingClientRect().width);
  if (width <= 440) await expect(page.getByRole('button', { name: /^Effort/ })).toBeHidden();
  await check('narrow-doc-960-light');
});

test('console stayed clean', async () => {
  expect(consoleErrors).toEqual([]);
});
