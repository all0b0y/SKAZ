#!/usr/bin/env node
/**
 * Build the SKAZ app icon from the shared tree geometry.
 *
 *   build/icon.icon  Icon Composer document; macOS 26 renders its Default, Dark,
 *                    Clear and Tinted appearances (electron-builder compiles it).
 *   build/icon.icns  Default appearance on Apple's 824-in-1024 grid, all sizes:
 *                    the DMG volume icon.
 *   icon/icon.png    The same 1024 render: README and the dev-mode Dock.
 *
 * Usage: node scripts/make-icon.mts [--previews <dir>]
 *   --previews renders every appearance to <dir> for review.
 * Requires Xcode 26+ (Icon Composer's ictool) and macOS sips/iconutil.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANVAS, CROWN_CIRCLES, ROOT_CELLS, TRUNK_PATH } from '../frontend/src/brand/treeGeometry.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DOC = path.join(REPO_ROOT, 'build', 'icon.icon');
const ICNS = path.join(REPO_ROOT, 'build', 'icon.icns');
const PNG = path.join(REPO_ROOT, 'icon', 'icon.png');

/** «Тил монохром»: one-tone tree, roots in a paler teal; graphite plate in Dark. */
const PALETTE = {
  default: { plate: ['#2f7c72', '#1b4a44'], tree: '#f3f6f4', roots: '#9fd6cb' },
  dark: { plate: ['#242c2a', '#111715'], tree: '#e7eeeb', roots: '#87c4b8' },
} as const;

/** ictool rendition names for the review set. */
const RENDITIONS = ['Default', 'Dark', 'ClearLight', 'ClearDark', 'TintedLight', 'TintedDark'] as const;

function srgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return `srgb:${r!.toFixed(5)},${g!.toFixed(5)},${b!.toFixed(5)},1.00000`;
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">${body}</svg>\n`;
}

/** Artwork is white; Icon Composer recolours each layer per appearance. */
function treeSvg(): string {
  const crown = CROWN_CIRCLES.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('');
  return svg(`<g fill="#ffffff">${crown}<path d="${TRUNK_PATH}"/></g>`);
}

function rootsSvg(): string {
  const pixels = ROOT_CELLS.map(
    (c) => `<rect x="${c.x}" y="${c.y}" width="${c.size}" height="${c.size}" rx="2" opacity="${c.opacity}"/>`,
  ).join('');
  return svg(`<g fill="#ffffff">${pixels}</g>`);
}

function layerFill(key: 'tree' | 'roots') {
  return [
    { value: { solid: srgb(PALETTE.default[key]) } },
    { appearance: 'dark', value: { solid: srgb(PALETTE.dark[key]) } },
  ];
}

function iconJson() {
  return {
    'fill-specializations': [
      { value: { 'linear-gradient': PALETTE.default.plate.map(srgb) } },
      { appearance: 'dark', value: { 'linear-gradient': PALETTE.dark.plate.map(srgb) } },
    ],
    groups: [
      {
        name: 'Tree',
        layers: [{ name: 'tree', 'image-name': 'tree.svg', glass: true, 'fill-specializations': layerFill('tree') }],
        shadow: { kind: 'neutral', opacity: 0.5 },
        translucency: { enabled: true, value: 0.4 },
        specular: true,
      },
      {
        name: 'Roots',
        layers: [{ name: 'roots', 'image-name': 'roots.svg', glass: false, 'fill-specializations': layerFill('roots') }],
        shadow: { kind: 'neutral', opacity: 0.3 },
        translucency: { enabled: false, value: 0 },
        specular: false,
      },
    ],
    'supported-platforms': { squares: 'shared' },
  };
}

function ictoolPath(): string {
  const developer = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
  const tool = path.resolve(developer, '../Applications/Icon Composer.app/Contents/Executables/ictool');
  if (!existsSync(tool)) throw new Error(`ictool not found at ${tool}; install Xcode 26 or newer`);
  return tool;
}

function render(ictool: string, rendition: string, output: string, size = 1024): void {
  execFileSync(ictool, [ICON_DOC, '--export-image', '--output-file', output, '--platform', 'macOS',
    '--rendition', rendition, '--width', String(size), '--height', String(size), '--scale', '1'], { stdio: 'pipe' });
}

/** Apple's grid: an 824-point plate centred in a 1024-point canvas (ictool renders the plate full-bleed). */
function renderOnGrid(ictool: string, size: number, output: string, work: string): void {
  const plate = path.join(work, `plate-${size}.png`);
  render(ictool, 'Default', plate, Math.round((size * 824) / 1024));
  execFileSync('sips', ['-p', String(size), String(size), plate, '--out', output], { stdio: 'pipe' });
}

function writeIconDocument(): void {
  rmSync(ICON_DOC, { recursive: true, force: true });
  mkdirSync(path.join(ICON_DOC, 'Assets'), { recursive: true });
  writeFileSync(path.join(ICON_DOC, 'Assets', 'tree.svg'), treeSvg());
  writeFileSync(path.join(ICON_DOC, 'Assets', 'roots.svg'), rootsSvg());
  writeFileSync(path.join(ICON_DOC, 'icon.json'), `${JSON.stringify(iconJson(), null, 2)}\n`);
}

/** Legacy .icns (DMG volume icon) and the 1024 PNG, both rendered from the document itself. */
function writeRasterIcons(ictool: string): void {
  const work = mkdtempSync(path.join(tmpdir(), 'skaz-icon-'));
  try {
    const iconset = path.join(work, 'icon.iconset');
    mkdirSync(iconset);
    for (const point of [16, 32, 128, 256, 512]) {
      renderOnGrid(ictool, point, path.join(iconset, `icon_${point}x${point}.png`), work);
      renderOnGrid(ictool, point * 2, path.join(iconset, `icon_${point}x${point}@2x.png`), work);
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', ICNS], { stdio: 'pipe' });
    copyFileSync(path.join(iconset, 'icon_512x512@2x.png'), PNG);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv: string[]): void {
  const previewsAt = argv.indexOf('--previews');
  const previews = previewsAt >= 0 ? argv[previewsAt + 1] : undefined;
  if (previewsAt >= 0 && !previews) throw new Error('--previews needs a directory');

  writeIconDocument();
  const ictool = ictoolPath();
  writeRasterIcons(ictool);
  if (previews) {
    mkdirSync(previews, { recursive: true });
    for (const rendition of RENDITIONS) render(ictool, rendition, path.join(previews, `${rendition}.png`));
  }
  console.log(`wrote ${path.relative(REPO_ROOT, ICON_DOC)}, ${path.relative(REPO_ROOT, ICNS)}, ${path.relative(REPO_ROOT, PNG)}` +
    (previews ? ` and ${RENDITIONS.length} previews in ${previews}` : ''));
}

main(process.argv.slice(2));
