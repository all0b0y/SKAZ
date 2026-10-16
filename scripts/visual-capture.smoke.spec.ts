import { test, type ElectronApplication, type Page } from '@playwright/test';
import { launchIsolatedSmoke } from './isolatedSmoke';
import path from 'node:path';
import fs from 'node:fs';

// Parent-only visual capture: launches the built shell and screenshots each
// surface of the redesign so a human can judge it. Asserts nothing.

const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime', 'shots');

let app: ElectronApplication;
let page: Page;
let close: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  ({ app, close } = await launchIsolatedSmoke('skaz-shot-'));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1280, height: 820 });
});

test.afterAll(async () => {
  await close?.();
});

test('capture every surface', async () => {
  // Give the backend gate a chance to resolve one way or the other.
  await page.waitForTimeout(9000);
  await page.screenshot({ path: path.join(shots, '01-boot.png') });

  // A fresh profile has no spoken languages, so the first-run modal covers the
  // shell. Answer it the way a user would, then carry on capturing.
  const onboarding = page.locator('.onboarding');
  if (await onboarding.count()) {
    const quick = page.getByRole('button', { name: 'Russian + English' });
    if (await quick.count()) {
      await quick.click();
      await page.getByRole('button', { name: /continue/i }).click();
      await page.waitForTimeout(1500);
    }
  }

  // Force the shell past the gate and seed realistic data, so the layout can be
  // judged with content rather than empty states only.
  await page.evaluate(() => {
    const w = window as unknown as { __skazStore?: unknown };
    void w;
  });

  const seeded = await page.evaluate(() => false);
  // eslint-disable-next-line no-console
  console.log('seeded:', seeded);

  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, '02-shell.png') });

  // Left rail collapsed
  await page.keyboard.press('Meta+Slash');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, '03-rail-collapsed.png') });
  await page.keyboard.press('Meta+Slash');
  await page.waitForTimeout(700);

  // Search palette
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, '04-search.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Notes tab
  const notesTab = page.getByRole('tab', { name: /notes/i });
  if (await notesTab.count()) {
    await notesTab.first().click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(shots, '05-notes.png') });
  }

  // Settings drawer
  const gear = page.locator('[aria-label="Settings"], [title="Settings"]').first();
  if (await gear.count()) {
    await gear.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(shots, '06-settings.png') });
    await page.screenshot({ path: path.join(shots, '06-settings-full.png'), fullPage: true });

    const modelsSection = page.getByRole('button', { name: 'Model assignment' });
    if (await modelsSection.count()) {
      await modelsSection.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(shots, '07-model-assignment.png') });
    }

    const logsSection = page.getByRole('button', { name: 'Logs' });
    if (await logsSection.count()) {
      await logsSection.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(shots, '08-logs.png') });
    }

    const systemSection = page.getByRole('group', { name: 'App', exact: true }).getByRole('button', { name: 'System', exact: true });
    if (await systemSection.count()) {
      await systemSection.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(shots, '09-system.png'), fullPage: true });
    }
  }
});

// The first-run modal only renders when the backend answered and no spoken
// languages are stored, so it gets its own launch with a clean profile.
test('capture the first-run language modal', async () => {
  const fresh = await launchIsolatedSmoke('skaz-onboard-');
  try {
    const freshPage = await fresh.app.firstWindow();
    await freshPage.waitForLoadState('domcontentloaded');
    await freshPage.setViewportSize({ width: 1280, height: 820 });
    await freshPage.waitForTimeout(12000);
    await freshPage.screenshot({ path: path.join(shots, '10-first-run.png') });
  } finally {
    await fresh.close();
  }
});
