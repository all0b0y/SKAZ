import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { trayIconSet } from './trayIcons';

/** Just enough of a PNG reader for the 8-bit RGBA, unfiltered images the generator writes. */
function readPng(base64: string) {
  const data = Buffer.from(base64, 'base64');
  expect(data.subarray(1, 4).toString()).toBe('PNG');
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  expect(data[24]).toBe(8);
  expect(data[25]).toBe(6);
  const parts: Buffer[] = [];
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at);
    if (data.subarray(at + 4, at + 8).toString() === 'IDAT') parts.push(data.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const pixel = (x: number, y: number) => {
    const i = y * (width * 4 + 1) + 1 + x * 4;
    return [raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!] as const;
  };
  return { width, height, pixel };
}

function pixels(image: ReturnType<typeof readPng>) {
  const out: Array<readonly [number, number, number, number]> = [];
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) out.push(image.pixel(x, y));
  return out;
}

describe('tray icons', () => {
  it('macOS: a template image at 18 pt + @2x, black with alpha only, so the system colours it', () => {
    const set = trayIconSet('darwin');
    expect(set.template).toBe(true);
    for (const [base64, size] of [[set.x1, 18], [set.x2, 36]] as const) {
      const image = readPng(base64);
      expect([image.width, image.height]).toEqual([size, size]);
      const all = pixels(image);
      expect(all.every(([r, g, b]) => r === 0 && g === 0 && b === 0)).toBe(true);
      expect(all.some(([, , , a]) => a === 255)).toBe(true);
      expect(all.some(([, , , a]) => a === 0)).toBe(true);
    }
  });

  it.each(['win32', 'linux'] as const)('%s: a 16 px + @2x plate, not a template: readable on dark and light bars', (platform) => {
    const set = trayIconSet(platform);
    expect(set.template).toBe(false);
    for (const [base64, size] of [[set.x1, 16], [set.x2, 32]] as const) {
      const image = readPng(base64);
      expect([image.width, image.height]).toEqual([size, size]);
      const middleTop = image.pixel(size >> 1, Math.round(size * 0.3));
      const middleEdge = image.pixel(1, size >> 1);
      expect(middleTop[0]).toBeGreaterThan(200); // the light tree…
      expect(middleEdge[0]).toBeLessThan(80); // …on the dark plate
      expect(middleEdge[3]).toBe(255);
    }
  });
});
