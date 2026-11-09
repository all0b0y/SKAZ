#!/usr/bin/env node
/**
 * Build the tray icons (decision 3f′) from the shared tree geometry and write them into electron/trayIcons.ts.
 * They live in the main bundle as base64, so they need no packaging rule and can't go missing from the app.
 *
 *   macOS            18 pt + @2x template: black with alpha, the system colours it for the menu bar.
 *   Windows, Linux   16 px + @2x: the light tree on the dark plate, readable on dark and light bars alike.
 *
 * Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/make-tray-icon.mts [--previews <dir>]
 * Plain Node and no other tools, so it also runs on Windows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { APP_ICON_PALETTE } from '../frontend/src/brand/appIcon.ts';
import { CROWN_CIRCLES, GROUND, TRUNK_PATH } from '../frontend/src/brand/treeGeometry.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO_ROOT, 'electron', 'trayIcons.ts');

type Point = readonly [number, number];
type Rgb = readonly [number, number, number];

/** The trunk path as a polygon: only the M, L, Q and Z the brand path uses. */
function flatten(d: string): Point[] {
  const out: Point[] = [];
  const tokens = d.match(/[MLQZ]|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  const point = (): Point => [Number(tokens[i++]), Number(tokens[i++])];
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M' || command === 'L') out.push(point());
    else if (command === 'Q') {
      const p0 = out[out.length - 1]!;
      const c = point();
      const p1 = point();
      for (let t = 1; t <= 12; t += 1) {
        const u = t / 12;
        out.push([
          (1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * c[0] + u ** 2 * p1[0],
          (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * c[1] + u ** 2 * p1[1],
        ]);
      }
    } else if (command !== 'Z') throw new Error(`unexpected path command ${command}`);
  }
  return out;
}

const TRUNK = flatten(TRUNK_PATH);

function inPolygon(x: number, y: number, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a, a += 1) {
    const [ax, ay] = polygon[a]!;
    const [bx, by] = polygon[b]!;
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function inTree(x: number, y: number): boolean {
  return CROWN_CIRCLES.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2) || inPolygon(x, y, TRUNK);
}

// The tree's own box in brand coordinates: the widest and highest circles, down to the ground.
const LEFT = Math.min(...CROWN_CIRCLES.map(([cx, , r]) => cx - r));
const RIGHT = Math.max(...CROWN_CIRCLES.map(([cx, , r]) => cx + r));
const TOP = Math.min(...CROWN_CIRCLES.map(([, cy, r]) => cy - r));
const SPAN = Math.max(RIGHT - LEFT, GROUND - TOP);
const CX = (LEFT + RIGHT) / 2;
const CY = (TOP + GROUND) / 2;
const SAMPLES = 8;

/** Covered share (0..1) of a pixel by a test given in pixel coordinates. */
function coverage(px: number, py: number, inside: (x: number, y: number) => boolean): number {
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      if (inside(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES)) hits += 1;
    }
  }
  return hits / SAMPLES ** 2;
}

/** The tree test in the pixels of a `size` canvas, the tree `fill` of the canvas across. */
function treeAt(size: number, fill: number) {
  const scale = SPAN / (size * fill);
  return (x: number, y: number) => inTree(CX + (x - size / 2) * scale, CY + (y - size / 2) * scale);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const tagged = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(tagged));
  return Buffer.concat([head, tagged, tail]);
}

function png(size: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0, at = 0; y < size; y += 1) {
    raw[at++] = 0; // no filter
    for (let x = 0; x < size; x += 1) for (const value of pixel(x, y)) raw[at++] = value;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function template(size: number): Buffer {
  const tree = treeAt(size, 0.88);
  return png(size, (x, y) => [0, 0, 0, Math.round(coverage(x, y, tree) * 255)]);
}

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb;
}

function plate(size: number): Buffer {
  const { plate: [, ground], tree: treeColour } = APP_ICON_PALETTE.dark;
  const back = rgb(ground);
  const front = rgb(treeColour);
  const radius = size * 0.22;
  const tree = treeAt(size, 0.76);
  const inPlate = (x: number, y: number) => {
    const dx = Math.max(radius - x, x - (size - radius), 0);
    const dy = Math.max(radius - y, y - (size - radius), 0);
    return dx ** 2 + dy ** 2 <= radius ** 2;
  };
  return png(size, (x, y) => {
    const t = coverage(x, y, tree);
    const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
    return [mix(back[0], front[0]), mix(back[1], front[1]), mix(back[2], front[2]), Math.round(coverage(x, y, inPlate) * 255)];
  });
}

const images = { template: template(18), template2x: template(36), plate: plate(16), plate2x: plate(32) };

const source = `// Generated by scripts/make-tray-icon.mts from the brand tree geometry. Do not edit by hand.

export interface TrayIconSet {
  /** macOS colours a template image itself for the menu bar's appearance. */
  template: boolean;
  /** Base64 PNG at 1x. */
  x1: string;
  /** Base64 PNG at 2x. */
  x2: string;
}

const TEMPLATE_X1 = '${images.template.toString('base64')}';
const TEMPLATE_X2 = '${images.template2x.toString('base64')}';
const PLATE_X1 = '${images.plate.toString('base64')}';
const PLATE_X2 = '${images.plate2x.toString('base64')}';

export function trayIconSet(platform: NodeJS.Platform): TrayIconSet {
  return platform === 'darwin'
    ? { template: true, x1: TEMPLATE_X1, x2: TEMPLATE_X2 }
    : { template: false, x1: PLATE_X1, x2: PLATE_X2 };
}
`;
writeFileSync(OUT, source);

const previewsAt = process.argv.indexOf('--previews');
if (previewsAt >= 0) {
  const dir = process.argv[previewsAt + 1];
  if (!dir) throw new Error('--previews needs a directory');
  mkdirSync(dir, { recursive: true });
  for (const [name, image] of Object.entries(images)) writeFileSync(path.join(dir, `${name}.png`), image);
}
