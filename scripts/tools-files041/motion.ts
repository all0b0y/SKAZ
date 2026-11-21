import { expect, type Locator, type Page } from '@playwright/test';

async function pose(target: Locator) {
  return target.evaluate(el => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return [m.e, m.a, m.d];
  });
}
async function sampleAt(target: Locator, time: number) {
  await target.evaluate((el, t) => {
    const animation = el.getAnimations()[0]; if (!animation) throw new Error('No tab transition');
    animation.pause(); animation.currentTime = t;
  }, time);
  return pose(target);
}

export async function verifyMotion(page: Page, pill: Locator, tab: (page: Page, name: string) => Locator) {
  for (const name of ['Skills', 'MCP']) {
    const button = tab(page, name);
    const geometry = await button.boundingBox();
    const textBounds = () => button.evaluate(el => {
      const text = [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) ?? el;
      const range = document.createRange(); range.selectNodeContents(text);
      const r = range.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
    });
    const label = await textBounds();
    await button.click();
    const animationTime = await pill.evaluate(el => el.getAnimations()[0]?.effect?.getTiming().duration);
    expect(animationTime).toBeCloseTo(280, 0);
    const stretch = await sampleAt(pill, 280 * .34);
    expect(stretch[1]).toBeCloseTo(1.14, 2); expect(stretch[2]).toBeCloseTo(.91, 2);
    const squeeze = await sampleAt(pill, 280 * .72);
    expect(squeeze[1]).toBeCloseTo(.955, 2); expect(squeeze[2]).toBeCloseTo(1.055, 2);
    expect(await button.boundingBox()).toEqual(geometry);
    expect(await textBounds()).toEqual(label);
    await sampleAt(pill, 280);
    expect((await pill.boundingBox())?.x).toBeCloseTo(geometry!.x, 0);
  }
  await tab(page, 'Skills').click();
  const mid = await sampleAt(pill, 95);
  // Both operations in one browser task so a compositor tick cannot advance the new transition.
  await tab(page, 'MCP').evaluate(el => {
    (el as HTMLElement).click();
    for (const a of el.closest('[role="tablist"]')!.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 0; }
  });
  const reverse = await pose(pill);
  reverse.forEach((value, i) => expect(value).toBeCloseTo(mid[i], 2));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => pill.evaluate(el => el.getAnimations().length)).toBe(0);
  await tab(page, 'MCP').focus(); await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Skills')).toBeFocused();
  expect(await pill.evaluate(el => el.getAnimations().length)).toBe(0);
}
