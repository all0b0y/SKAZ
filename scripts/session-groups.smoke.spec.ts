import { expect, test, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime/session-groups');
const capture = async (page: Page, filename: string) => {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
      .map((a) => a.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: path.join(shots, filename), animations: 'disabled' });
};
const createGroup = async (page: Page, name: string, tag = '') => {
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByRole('textbox', { name: 'Group name', exact: true }).fill(name);
  if (tag) await page.getByRole('textbox', { name: 'Tag (optional)', exact: true }).fill(tag);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

// Real built renderer + local backend in an isolated profile. No microphone,
// model fixtures, network provider or personal sessions are used.
test('session groups, real drag, menus and restart persistence', async () => {
  test.setTimeout(120_000);
  await fs.mkdir(shots, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-groups-')));
  const launch = () => electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      // Opt-in dev renderer exercises StrictMode effect replay; profile/backend
      // remain isolated even when using an already running Vite server.
      ...(process.env.AUDIOHELPER_GROUPS_DEV_URL ? { ELECTRON_RENDERER_URL: process.env.AUDIOHELPER_GROUPS_DEV_URL } : {}),
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0' },
  });
  let app = await launch();
  const errors: string[] = [];
  try {
    let page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 820 });
    // Isolated onboarding preference only (as panels.smoke): no credentials or consent.
    await expect.poll(() => page.evaluate(async () => (await window.audiohelper.getBackendStatus()).phase),
      { timeout: 60_000 }).toBe('ready');
    await page.evaluate(async () => {
      const response = await window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } });
      if (!response.ok) throw new Error('Fixture onboarding failed');
    });
    await page.reload();
    await expect(page.locator('.onboarding')).toHaveCount(0);
    await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
    await page.getByRole('button', { name: 'New session' }).click();
    const row = page.getByRole('list', { name: 'Saved sessions' }).getByRole('listitem');
    await expect(row.locator('.session__name')).toHaveText(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/);
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Session name' }).fill('Лекция по физике');
    await page.keyboard.press('Enter');
    await expect(row.locator('.session__name')).toHaveText('Лекция по физике');
    await createGroup(page, 'Учёба', '#универ');
    await createGroup(page, 'Работа', '#проект');
    const study = page.getByRole('tab', { name: /Учёба/ });
    const work = page.getByRole('tab', { name: /Работа/ });
    await row.dragTo(study);
    await expect(study).toContainText('1');
    await study.click(); await expect(row).toHaveCount(1);
    await page.getByRole('tab', { name: /^All/ }).click();
    await row.dragTo(work); await expect(study).toContainText('0'); await expect(work).toContainText('1');
    await row.dragTo(page.getByRole('tab', { name: /^All/ })); await expect(work).toContainText('0');
    await row.dragTo(study); await expect(study).toContainText('1');
    // Force crossing the midpoint, rather than dropping on a still-moving edge.
    await work.dragTo(study, { targetPosition: { x: 5, y: 12 } });
    await expect(page.getByRole('tablist', { name: 'Session groups' }).getByRole('tab').nth(1)).toContainText('Работа');
    await capture(page, 'light.png');
    const bounds = await page.locator('.rail__chips .chip').evaluateAll((chips) => chips.map((chip) => {
      const { left, top, right, bottom } = chip.getBoundingClientRect(); return { left, top, right, bottom };
    }));
    for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) {
      const a = bounds[i]!; const b = bounds[j]!;
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
    await expect(page.locator('.session-navigation-announcement')).toHaveCSS('position', 'absolute');
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await capture(page, 'session-menu.png');
    await page.keyboard.press('Escape');
    await study.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit name and tag' }).click();
    await page.getByRole('textbox', { name: 'Group name' }).fill('Университет');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Университет #универ 1/ })).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    await page.getByRole('textbox', { name: 'Group name' }).fill('Новая группа');
    await capture(page, 'dark-dialog.png');
    await page.keyboard.press('Escape');
    await app.close(); app = await launch(); page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('tab', { name: /Университет #универ 1/ })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Session groups' }).getByRole('tab').nth(1)).toContainText('Работа');
    await expect(page.locator('.session__name')).toHaveText('Лекция по физике');
    await page.getByRole('tab', { name: /Университет/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete group…' }).click();
    await expect(page.getByRole('dialog')).toContainText('sessions will remain in All');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.session__name')).toHaveText('Лекция по физике');
    await page.reload();
    await expect(page.getByRole('tab', { name: /Университет/ })).toHaveCount(0);
    await expect(page.locator('.session__name')).toHaveText('Лекция по физике');
    await page.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Delete session…' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.session__name')).toHaveCount(1);
    await page.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Delete session…' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.session__name')).toHaveCount(0);
    await page.reload(); await expect(page.getByText('No sessions yet. Start one to begin listening.')).toBeVisible();

    // Bulk actions against the real backend: ⌘-click / ⌘A, move, one-confirmation delete.
    for (const title of ['Раз', 'Два', 'Три']) {
      await page.getByRole('button', { name: 'New session' }).click();
      const newest = page.getByRole('list', { name: 'Saved sessions' }).getByRole('listitem')
        .filter({ has: page.locator('.session__name', { hasText: /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/ }) });
      await expect(newest).toHaveCount(1);
      await newest.getByRole('button', { name: /^Actions for/ }).click();
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
      await page.getByRole('textbox', { name: 'Session name' }).fill(title);
      await page.keyboard.press('Enter');
      await expect(page.locator('.session__name', { hasText: title })).toHaveCount(1);
    }
    const list = page.getByRole('list', { name: 'Saved sessions' });
    await list.getByRole('button', { name: /^Раз/ }).click({ modifiers: ['Meta'] });
    await list.getByRole('button', { name: /^Три/ }).click({ modifiers: ['Meta'] });
    const bar = page.getByRole('toolbar', { name: 'Selected sessions' });
    await expect(bar).toContainText('2 selected');
    await bar.getByRole('button', { name: 'Move…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Работа' }).click();
    await expect(page.getByRole('tab', { name: /Работа/ })).toContainText('2');
    await list.getByRole('button', { name: /^Два/ }).click({ modifiers: ['Meta'] });
    await page.keyboard.press('Meta+a');
    await expect(bar).toContainText('3 selected');
    await capture(page, 'bulk-selection.png');
    await bar.getByRole('button', { name: 'Delete…' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete 3 sessions?' })).toContainText('Два');
    await capture(page, 'bulk-delete-dialog.png');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.session__name')).toHaveCount(0);
    await page.reload(); await expect(page.getByText('No sessions yet. Start one to begin listening.')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
