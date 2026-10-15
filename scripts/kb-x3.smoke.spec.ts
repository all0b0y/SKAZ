import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';

// The startup screen (X3, mockup loading-tree-v41 variant A) in the real built Electron app on the
// real local backend, isolated profile. Starting is shown again through main's own status event
// (a real start is over too soon to look at); the error is real: the backend process is killed,
// main reports its exit, Try again restarts it for real. Screenshots at 1440, light and dark.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_X3_SHOTS ?? path.join(root, '.runtime', 'shots', 'x3');

let app: ElectronApplication;
let page: Page;
let close: () => Promise<void>;
const pageErrors: string[] = [];

async function setView(theme: 'light' | 'dark', reducedMotion: 'reduce' | 'no-preference' = 'no-preference') {
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
}

/** What main sends the window when the backend changes phase. */
async function sendStatus(status: { phase: string; detail?: string }) {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('backend:status-event', s);
  }, status);
}

async function phase(): Promise<string> {
  return page.evaluate(async () => (await window.skaz.getBackendStatus()).phase);
}

/** Layout of the mark: the tree's box (deep pixels optional), the window, the message. */
async function layout(withDeep: boolean) {
  return page.evaluate((deep) => {
    const svg = document.querySelector('[data-testid="loading-tree"] svg')!;
    const parts = Array.from(svg.querySelectorAll('.skaz-loading__tree, .skaz-loading__grove, .skaz-loading__px'))
      .filter((el) => deep || !el.classList.contains('skaz-loading__px--deep'))
      .map((el) => el.getBoundingClientRect());
    const box = {
      top: Math.min(...parts.map((r) => r.top)), bottom: Math.max(...parts.map((r) => r.bottom)),
      left: Math.min(...parts.map((r) => r.left)), right: Math.max(...parts.map((r) => r.right)),
    };
    const message = document.querySelector('.skaz-loading__message')?.getBoundingClientRect() ?? null;
    return { box, width: innerWidth, height: innerHeight, messageTop: message?.top ?? null, messageBottom: message?.bottom ?? null };
  }, withDeep);
}

async function animationOf(selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).animationName);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  ({ app, close } = await launchIsolatedSmoke('skaz-kb-x3-'));
  page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(phase, { timeout: 60_000 }).toBe('ready');
  await expect(page.getByTestId('loading-tree')).toHaveCount(0, { timeout: 10_000 });
});

test.afterAll(async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  await close?.();
});

test('starting: the tree alone, centred, roots inside the window; sap on the roots and grove only', async () => {
  await sendStatus({ phase: 'starting' });
  const tree = page.getByTestId('loading-tree');
  await expect(tree).toHaveAttribute('data-phase', 'starting');
  await expect(page.getByRole('status').filter({ hasText: 'Starting SKAZ…' })).toHaveCount(1);
  await expect(page.getByText('Starting SKAZ…')).not.toBeInViewport();
  for (const theme of ['light', 'dark'] as const) {
    await setView(theme);
    await expect(tree).toHaveAttribute('data-motion', 'full');
    expect(await animationOf('.skaz-loading__px')).toBe('skaz-loading-sap');
    expect(await animationOf('.skaz-loading__grove--blue')).toBe('skaz-loading-grove');
    expect(await animationOf('.skaz-loading__tree')).toBe('none');
    const { box, width, height } = await layout(true);
    // Whole tree centred in the window; the roots end well inside it.
    expect(Math.abs((box.left + box.right) / 2 - width / 2)).toBeLessThan(width * 0.01);
    expect(Math.abs((box.top + box.bottom) / 2 - height / 2)).toBeLessThan(height * 0.02);
    expect(height - box.bottom).toBeGreaterThan(height * 0.08);
    await page.waitForTimeout(1300); // a wave half-way up the roots
    await page.screenshot({ path: path.join(shots, `starting-1440-${theme}.png`) });
  }
});

test('reduced motion: nothing moves, the roots pulse slowly in opacity', async () => {
  await setView('light', 'reduce');
  await expect(page.getByTestId('loading-tree')).toHaveAttribute('data-motion', 'reduced');
  expect(await animationOf('.skaz-loading__px')).toBe('none');
  expect(await animationOf('.skaz-loading__grove--blue')).toBe('none');
  expect(await animationOf('.skaz-loading__roots')).toBe('skaz-loading-pulse');
  await setView('light');
});

test('ready: the app comes at once and the tree fades out over it', async () => {
  await sendStatus({ phase: 'ready', detail: 'smoke' });
  await expect(page.getByTestId('loading-tree')).toHaveAttribute('data-phase', 'ready', { timeout: 1000 });
  await expect(page.getByTestId('loading-tree')).toHaveCount(0, { timeout: 2000 });
  await expect(page.getByRole('dialog', { name: 'Welcome to SKAZ' })).toBeVisible();
});

test('error (real backend exit): amber roots, deep pixels fall, the tree above the message; Try again restarts', async () => {
  const mainPid = app.process().pid!;
  const backend = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n').map((line) => line.trim().split(/\s+/))
    .find(([, ppid, ...cmd]) => Number(ppid) === mainPid && cmd.join(' ').includes('-m skaz'));
  expect(backend, 'backend child of the app').toBeTruthy();
  process.kill(Number(backend![0]), 'SIGKILL');

  const tree = page.getByTestId('loading-tree');
  await expect(tree).toHaveAttribute('data-phase', 'error', { timeout: 10_000 });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('SKAZ couldn’t start its local service.');
  await expect(alert).toContainText('backend exited');
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Open logs folder' })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await setView(theme);
    await page.waitForTimeout(1500); // the lift and the fall are over
    const warn = await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--kb-warn)';
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    });
    expect(await page.locator('.skaz-loading__px').first().evaluate((el) => getComputedStyle(el).fill)).toBe(warn);
    expect(await page.locator('.skaz-loading__px--deep').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    const { box, messageTop, messageBottom, height } = await layout(false);
    expect(box.bottom, 'the tree never overlaps the message').toBeLessThan(messageTop! - 8);
    expect(box.top).toBeGreaterThan(0);
    expect(height - messageBottom!).toBeLessThan(40);
    await page.screenshot({ path: path.join(shots, `error-1440-${theme}.png`) });
  }

  await setView('light');
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(tree).toHaveAttribute('data-phase', 'starting');
  expect(await animationOf('.skaz-loading__px')).toBe('skaz-loading-sap');
  await expect.poll(phase, { timeout: 60_000 }).toBe('ready');
  await expect(tree).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByRole('dialog', { name: 'Welcome to SKAZ' })).toBeVisible();
});

test('no uncaught errors in the window', async () => {
  expect(pageErrors).toEqual([]);
});
