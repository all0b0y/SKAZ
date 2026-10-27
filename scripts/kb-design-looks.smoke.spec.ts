import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';

// Design-system look review (.dev/docs/DESIGN-SYSTEM.md, verification 3): the real built app with
// every preset in both themes, plus Settings → Appearance. Screens are for eye review (no pixel
// diffs); the test asserts only that each look is really applied to <html> and nothing errors.

const shots = process.env.SKAZ_DESIGN_SHOTS ?? path.join(path.resolve(__dirname, '..'), '.runtime', 'shots', 'kb-design');
const PRESETS = {
  skaz: { base: 'milk', accent: 'ink', density: 'comfortable', motion: 'full' },
  lecture: { base: 'sand', accent: 'clay', density: 'spacious', motion: 'calm' },
  focus: { base: 'paper', accent: 'ink', density: 'compact', motion: 'calm' },
  slate: { base: 'slate', accent: 'slate', density: 'comfortable', motion: 'full' },
} as const;

let app: ElectronApplication;
let page: Page;
let close: () => Promise<void>;
const errors: string[] = [];

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  ({ app, close } = await launchIsolatedSmoke('skaz-kb-design-shots-'));
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => { await close?.(); });

for (const theme of ['light', 'dark'] as const) {
  for (const [name, look] of Object.entries(PRESETS)) {
    test(`${name} · ${theme}`, async () => {
      await page.evaluate((prefs) => localStorage.setItem('skaz.kb.prefs', JSON.stringify(prefs)), { onboardingDone: true, theme, ...look });
      await page.reload();
      await page.waitForSelector('[aria-label="Sections"]', { timeout: 30_000 });
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => ({ ...document.documentElement.dataset }))).toMatchObject({ theme, ...look });
      await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
      if (name === 'skaz' || name === 'lecture') {
        await page.keyboard.press('Meta+,');
        const dialog = page.getByRole('dialog', { name: 'Settings' });
        await dialog.getByRole('button', { name: 'Appearance' }).click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(shots, `appearance-${name}-${theme}.png`) });
        await page.keyboard.press('Escape');
      }
    });
  }
}

test('no page errors', () => { expect(errors).toEqual([]); });
