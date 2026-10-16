import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';

declare global {
  interface Window {
    __motionStarts: { name: string; target: string }[];
    __motionSurfaces: { target: string; duration: OptionalEffectTiming['duration'] }[];
  }
}
const evidence = path.resolve('.dev/motion/verification');

// Real built Electron + isolated local backend. No microphone, credentials,
// model download or paid calls. Instrumentation observes the real animation API.
test('first-run motion, interrupted navigation and reduced motion preserve working controls', async () => {
  test.setTimeout(120_000);
  fs.mkdirSync(evidence, { recursive: true });
  const { app, close } = await launchIsolatedSmoke('skaz-motion-');
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
    await page.addInitScript(() => {
      const observation = window;
      observation.__motionStarts = [];
      observation.__motionSurfaces = [];
      document.addEventListener('animationstart', event => {
        observation.__motionStarts.push({ name: event.animationName,
          target: (event.target as Element).getAttribute('class') ?? '' });
      }, true);
      const original = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        observation.__motionSurfaces.push({ target: this.getAttribute('class') ?? '',
          duration: typeof options === 'number' ? options : options?.duration });
        return original.call(this, keyframes, options);
      };
    });
    await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
      { timeout: 60_000 }).toBe('ready');
    await page.reload();
    const onboarding = page.getByRole('dialog', { name: 'Which languages do you speak?' });
    await expect(onboarding).toBeVisible();
    expect(await page.locator('.onboarding__card').evaluate(node => getComputedStyle(node).animationName)).toBe('skaz-card-in');
    await page.locator('.onboarding__card').evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    await page.screenshot({ path: path.join(evidence, 'first-run-light.png') });
    const initialOnboardingStarts = await page.evaluate(() =>
      (window).__motionStarts.filter(item => item.target === 'onboarding__card').length);
    expect(initialOnboardingStarts).toBe(1);
    await onboarding.getByRole('button', { name: 'Russian + English', exact: true }).click();
    await expect(onboarding.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    await onboarding.getByRole('searchbox').fill('german');
    await expect(onboarding.getByRole('checkbox', { name: 'German', exact: true })).toBeVisible();
    expect(await page.evaluate(() =>
      (window).__motionStarts.filter(item => item.target === 'onboarding__card').length)).toBe(initialOnboardingStarts);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(evidence, 'first-run-dark.png') });
    await onboarding.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(onboarding).toHaveCount(0);
    await expect(page.locator('.app')).toHaveAttribute('data-motion-ready', 'true');
    await expect(page.locator('.onboarding')).toHaveCount(0);
    const setting = await page.evaluate(() => window.skaz.request<{ used_languages: string[] }>({ method: 'GET', path: '/settings' }));
    expect(setting.ok && setting.data.used_languages).toEqual(['ru', 'en']);
    const startup = await page.evaluate(() => (window).__motionStarts);
    expect(startup.some(item => item.target === 'center__head' && item.name === 'skaz-arrive')).toBe(true);
    expect(startup.some(item => item.target === 'center__footer' && item.name === 'skaz-arrive')).toBe(true);

    // Actual local session creation remains available; no wait for an animation.
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.locator('.capsule')).toBeVisible();
    await expect(page.locator('.session--active')).toHaveCount(1);
    await expect(page.locator('.center__title')).not.toHaveText('Your workspace');
    const centerCount = () => page.evaluate(() => (window).__motionSurfaces
      .filter(item => item.target === 'center__content').length);
    const beforeTabs = await centerCount();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
    expect(await centerCount()).toBe(beforeTabs + 2);
    // Unrelated settings/progress reads must not replay the content animation.
    await page.evaluate(() => window.skaz.request({ method: 'GET', path: '/settings' }));
    expect(await centerCount()).toBe(beforeTabs + 2);

    const settingsTrigger = page.getByRole('button', { name: 'Settings', exact: true });
    await settingsTrigger.click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'API keys', exact: true }).click();
    // A typed preference stays intact across animated settings navigation.
    const consent = settings.getByRole('checkbox').first();
    const consentBefore = await consent.isChecked();
    await consent.setChecked(!consentBefore);
    await settings.getByRole('button', { name: 'System', exact: true }).click();
    expect(await page.locator('.settings-content').evaluate(node => node.scrollTop)).toBe(0);
    await settings.getByRole('button', { name: 'API keys', exact: true }).click();
    await expect(settings.getByRole('checkbox').first()).toBeChecked({ checked: !consentBefore });
    const sectionCount = await page.evaluate(() => (window).__motionSurfaces
      .filter(item => item.target === 'settings-content').length);
    expect(sectionCount).toBeGreaterThanOrEqual(4);
    // Observe immediate semantic dismissal + real retained visual exit.
    const exit = await settings.locator('.drawer__close').evaluate(button => {
      (button as HTMLButtonElement).click();
      return new Promise<{ hidden: boolean; inert: boolean }>(resolve => requestAnimationFrame(() => {
        const wrapper = document.querySelector('.motion-presence[data-state="exit"]');
        resolve({ hidden: wrapper?.getAttribute('aria-hidden') === 'true', inert: wrapper?.hasAttribute('inert') ?? false });
      }));
    });
    expect(exit).toEqual({ hidden: true, inert: true });
    await expect(settings).toHaveCount(0);
    await expect(settingsTrigger).toBeFocused();
    await settingsTrigger.click();
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'System', exact: true }).click();
    await page.locator('.drawer__panel').evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    await page.screenshot({ path: path.join(evidence, 'settings-dark.png') });
    await settings.locator('.drawer__close').click();
    await expect(page.locator('.drawer')).toHaveCount(0);

    await page.getByRole('button', { name: 'Search materials' }).click();
    const search = page.getByRole('dialog', { name: 'Search materials' });
    await expect(search.getByRole('textbox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide assistant' }).click();
    await expect(page.locator('[data-panel="assistant"]')).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: 'Show assistant' }).click();
    await expect(page.locator('[data-panel="assistant"]')).not.toHaveAttribute('inert', '');

    // System setting changes live, including WAAPI navigation, not just CSS.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedBefore = await centerCount();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
    expect(await centerCount()).toBe(reducedBefore);
    await settingsTrigger.click();
    await expect(settings).toBeVisible();
    expect(await page.locator('.drawer__panel').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
    await settings.locator('.drawer__close').click();
    await expect(page.locator('.drawer')).toHaveCount(0);
    expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 820]) {
        await page.setViewportSize({ width, height: 800 });
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: path.join(evidence, `workspace-${theme}-${width}.png`) });
      }
    }
    await page.reload();
    await expect(page.locator('.app')).toHaveAttribute('data-motion-ready', 'true');
    await expect(page.locator('.onboarding')).toHaveCount(0);
    expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
    expect(errors).toEqual([]);
    const result = { startup, sectionCount, errors, reducedMotion: true, onboardingReplay: false,
      surfaces: await page.evaluate(() => (window).__motionSurfaces) };
    fs.writeFileSync(path.join(evidence, 'motion-smoke.json'), JSON.stringify(result, null, 2));
  } finally { await close(); }
});
