import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const reference = path.resolve(__dirname, '../../.dev/docs/0.4.1/tools-skills-files/refs');
export const baseline = path.join(__dirname, 'baseline');
export const sizes = [820, 1440] as const;
export const themes = ['light', 'dark'] as const;
export type Theme = typeof themes[number];

export async function openMock(page: Page, surface: 'tools' | 'chat', theme: Theme) {
  await page.goto(pathToFileURL(path.join(reference, surface, 'index.html')).href);
  if (theme === 'dark') await page.locator('#theme').click();
  await page.evaluate(() => document.fonts.ready);
}

// Sample real pixels straddling the lower-left corner, including the surrounding surface.
// Subtract a second capture with only the target's shadow suppressed to remove backdrop content.
export async function shadow(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Shadow target has no rendered bounds');
  const clip = { x: Math.round(box.x) - 12, y: Math.round(box.y + box.height) - 10, width: 64, height: 38 };
  const raw = await page.screenshot({ clip });
  const previous = await target.evaluate(el => {
    const style = (el as HTMLElement).style;
    const saved = style.cssText;
    style.setProperty('box-shadow', 'none', 'important');
    return saved;
  });
  let off: Buffer;
  try { off = await page.screenshot({ clip }); }
  finally { await target.evaluate((el, style) => { (el as HTMLElement).style.cssText = style; }, previous); }
  const encoded = await page.evaluate(async ([before, after]) => {
    async function raster(data: string) {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return { c, ctx, pixels: ctx.getImageData(0, 0, c.width, c.height) };
    }
    const a = await raster(before), b = await raster(after);
    for (let i = 0; i < a.pixels.data.length; i++) {
      if (i % 4 !== 3) a.pixels.data[i] = Math.abs(a.pixels.data[i] - b.pixels.data[i]);
    }
    a.ctx.putImageData(a.pixels, 0, 0);
    return a.c.toDataURL().split(',')[1];
  }, [raw.toString('base64'), off.toString('base64')]);
  return { raw, delta: Buffer.from(encoded, 'base64') };
}

// Dialogs sit over different real chat/settings content. Hold the ground constant while sampling
// the actual dialog, including its boundary and every shadow pixel. The original UI is captured first.
export async function dialogShadow(page: Page, target: Locator) {
  expect(await target.evaluate(el => getComputedStyle(el, '::backdrop').backgroundColor))
    .toBe('rgba(10, 14, 13, 0.38)');
  const ground = await page.addStyleTag({ content: 'dialog::backdrop { background: rgb(192, 192, 192) !important; }' });
  try { return await shadow(page, target); }
  finally { await ground.evaluate(el => el.remove()); }
}

export function saveReference(name: string, sample: Awaited<ReturnType<typeof shadow>>) {
  fs.mkdirSync(baseline, { recursive: true });
  fs.writeFileSync(path.join(baseline, name + '.png'), sample.delta);
  fs.writeFileSync(path.join(baseline, name + '-raw.png'), sample.raw);
}

export async function compare(page: Page, name: string, actual: Buffer, output?: string) {
  const wanted = fs.readFileSync(path.join(baseline, name + '.png'));
  // Decode both in the same renderer. PNG compression/metadata can differ between captures.
  const mismatch = await page.evaluate(async ([a, b]) => {
    const decode = async (data: string) => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      return { canvas, ctx, rgba: ctx.getImageData(0, 0, image.width, image.height) };
    };
    const x = await decode(a), y = await decode(b);
    let count = 0;
    for (let i = 0; i < x.rgba.data.length; i += 4) {
      const channels = [0, 1, 2].filter(k => Math.abs(x.rgba.data[i + k] - y.rgba.data[i + k]) > 3);
      count += channels.length;
      if (channels.length) x.rgba.data.set([255, 40, 40, 255], i);
    }
    x.ctx.putImageData(x.rgba, 0, 0);
    return { count, diff: x.canvas.toDataURL().split(',')[1] };
  }, [actual.toString('base64'), wanted.toString('base64')]);
  if (output) fs.writeFileSync(output, Buffer.from(mismatch.diff, 'base64'));
  return mismatch.count;
}

export async function visibleAndFits(target: Locator) {
  await expect(target).toBeVisible();
  expect(await target.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}
