import { test, expect } from '@playwright/test';
import { verifyMotion } from './tools-files041/motion';
import { compare, dialogShadow, openMock, saveReference, shadow, sizes, themes } from './tools-files041/shadows';

// Only this reference suite can write the golden PNGs. It only ever opens the approved local HTML.
for (const theme of themes) for (const width of sizes) {
  test('V2 reference and shadow-removal control ' + theme + ' ' + width, async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width, height: 920 }, deviceScaleFactor: 1 });
    try {
      for (const surface of ['tools', 'chat'] as const) {
        await openMock(page, surface, theme);
        const captures = surface === 'tools' ? ['pill', 'idle', 'dialog'] : ['dialog'];
        for (const kind of captures) {
          if (kind === 'dialog') {
            if (surface === 'tools') await page.getByRole('button', { name: 'Add MCP' }).click();
            else await page.getByRole('button', { name: 'Preview', exact: true }).click();
          }
          const target = kind === 'pill' ? page.locator('#tab-pill') : kind === 'idle'
            ? page.getByRole('tab', { name: 'Skills' }) : page.getByRole('dialog');
          const dialog = kind === 'dialog';
          const name = [surface, dialog ? 'dialog-neutral' : kind, theme, width].join('-');
          const measure = dialog ? dialogShadow : shadow;
          const sample = await measure(page, target);
          if (process.env[dialog ? 'SKAZ_RECORD_DIALOG_GROUND' : 'SKAZ_RECORD_APPROVED_HTML'] === '1') saveReference(name, sample);
          expect(await compare(page, name, sample.delta)).toBe(0);
          await target.evaluate(el => (el as HTMLElement).style.setProperty('box-shadow', 'none', 'important'));
          const missing = await measure(page, target);
          await target.evaluate(el => (el as HTMLElement).style.removeProperty('box-shadow'));
          const diff = await compare(page, name, missing.delta);
          if (kind === 'idle') expect(diff).toBe(0);
          else expect(diff, name + ' must detect a removed shadow').toBeGreaterThan(4);
        }
      }
    } finally { await page.close(); }
  });
}

test('V3 deterministic motion control on the approved HTML', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await openMock(page, 'tools', 'light');
  await verifyMotion(page, page.locator('#tab-pill'), (p, name) => p.getByRole('tab', { name }));
});
