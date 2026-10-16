import { expect, test } from '@playwright/test';
import { launchIsolatedSmoke } from './isolatedSmoke';

// Real built shell, isolated profile and session API; no recording or provider calls.
test('workspace typography, contrast and controls fit both themes and narrow windows', async () => {
  test.setTimeout(120_000);
  const { app, close } = await launchIsolatedSmoke('skaz-workspace-design-');
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
      { timeout: 60_000 }).toBe('ready');
    // Ready status can precede installing the request handler by one main-process turn.
    await expect.poll(() => page.evaluate(async () => (await window.skaz.request({ method: 'GET', path: '/settings' })).ok))
      .toBe(true);
    await page.evaluate(async () => {
      const result = await window.skaz.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru', 'en'] } });
      if (!result.ok) throw new Error('Isolated language preference was not saved');
    });
    await page.reload();
    await expect(page.locator('.gate')).toHaveCount(0);
    await expect(page.locator('.onboarding')).toHaveCount(0);
    const create = page.getByRole('button', { name: 'New session', exact: true });
    await expect(create).toHaveText('New session');
    await expect(page.getByRole('button', { name: 'Search materials' })).toContainText('Search');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toContainText('Settings');
    await create.click();
    await expect(page.locator('.capsule')).toBeVisible();
    await page.evaluate(async () => {
      const result = await window.skaz.request<{ sessions: { id: string }[] }>({ method: 'GET', path: '/sessions' });
      if (!result.ok || !result.data.sessions[0]) throw new Error('Isolated session was not created');
      const renamed = await window.skaz.request({ method: 'PATCH', path: `/sessions/${result.data.sessions[0].id}`,
        body: { title: 'Дизайн сессии — Session workspace #Study' } });
      if (!renamed.ok) throw new Error('Isolated session rename failed');
    });
    await page.reload();
    const heading = page.getByRole('heading', { level: 1, name: 'Дизайн сессии — Session workspace' });
    await expect(heading).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.fonts.load('600 20px Manrope', 'Дизайн Session'));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.center__title' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every((font: { isCustomFont: boolean; familyName: string }) =>
      font.isCustomFont && font.familyName.includes('Manrope'))).toBe(true);
    await cdp.detach();

    let ratiosChecked = 0;
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      const ratios = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const rgb = (color: string) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const luminance = (values: number[]) => values.map((channel) => {
          const v = channel / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
        const contrast = (foreground: string, background: string) => {
          const a = luminance(rgb(foreground));
          const b = luminance(rgb(background));
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const pairs: [string, string][] = [
          ['--ink', '--paper'], ['--ink-soft', '--paper-sunken'],
          ['--ink-faint', '--paper'], ['--ink-faint', '--paper-sunken'],
          ['--accent', '--paper'], ['--on-accent', '--accent'], ['--on-live', '--live'],
        ];
        const ratios = pairs.map(([foreground, background]) => ({
          foreground, background,
          ratio: contrast(style.getPropertyValue(foreground).trim(), style.getPropertyValue(background).trim()),
        }));
        // Style-only probe of an existing filled control; no provider/recording action.
        const selected = document.createElement('button');
        selected.className = 'segmented__on';
        document.body.append(selected);
        const selectedStyle = getComputedStyle(selected);
        ratios.push({ foreground: 'segmented__on text', background: 'segmented__on fill',
          ratio: contrast(selectedStyle.color, selectedStyle.backgroundColor) });
        selected.remove();
        return ratios;
      });
      for (const { foreground, background, ratio } of ratios) {
        expect(ratio, `${theme} ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
        ratiosChecked += 1;
      }
      for (const width of [1440, 1024, 820]) {
        await page.setViewportSize({ width, height: 768 });
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(heading).toBeVisible();
        const fits = await page.locator('.center__head').evaluate((element) => {
          const pane = element.closest('.center')!.getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          return rect.left >= pane.left && rect.right <= pane.right && rect.height > 0;
        });
        expect(fits).toBe(true);
        await expect(page.getByRole('button', { name: 'Search materials' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
      }
    }
    expect(errors).toEqual([]);
    console.log('Workspace QA:', JSON.stringify({ fonts, ratiosChecked, viewportChecks: 6, errors }));
  } finally {
    await close();
  }
});
