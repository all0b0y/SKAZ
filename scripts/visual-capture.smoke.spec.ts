import { test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Parent-only visual capture: launches the built shell and screenshots each
// surface of the redesign so a human can judge it. Asserts nothing.

const root = path.resolve(__dirname, '..');
const mainEntry = path.join(root, 'dist', 'main', 'main.js');
const shots = path.join(root, '.runtime', 'shots');

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-shot-'));
  app = await electron.launch({
    args: [mainEntry, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', SKAZ_SHOT_USER_DATA: userData },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1280, height: 820 });
});

test.afterAll(async () => {
  await app?.close();
});

test('capture every surface', async () => {
  // Give the backend gate a chance to resolve one way or the other.
  await page.waitForTimeout(9000);
  await page.screenshot({ path: path.join(shots, '01-boot.png') });

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
  }
});
