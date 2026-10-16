#!/usr/bin/env node
/**
 * Build the SKAZ app icon (decision 38, «Роща + цветные корни») from the shared tree
 * geometry. The document itself — palette, grove, layers — is described by
 * frontend/src/brand/appIcon.ts; this script writes it and renders it.
 *
 *   build/icon.icon  Icon Composer document; macOS 26 renders its Default, Dark,
 *                    Clear and Tinted appearances (electron-builder compiles it).
 *   build/icon.icns  Default appearance on Apple's 824-in-1024 grid, all sizes:
 *                    the DMG volume icon.
 *   icon/icon.png    The same 1024 render: README and the dev-mode Dock.
 *
 * Usage: node scripts/make-icon.mts [--previews <dir>]
 *   --previews renders every appearance to <dir> for review, plus Default and Dark
 *   at 1024/128/64/32/16 px.
 * Requires Xcode 26+ (Icon Composer's ictool) and macOS sips/iconutil.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconAssets, iconDocument } from '../frontend/src/brand/appIcon.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DOC = path.join(REPO_ROOT, 'build', 'icon.icon');
const ICNS = path.join(REPO_ROOT, 'build', 'icon.icns');
const PNG = path.join(REPO_ROOT, 'icon', 'icon.png');

/** ictool rendition names for the review set. */
const RENDITIONS = ['Default', 'Dark', 'ClearLight', 'ClearDark', 'TintedLight', 'TintedDark'] as const;
/** Extra review sizes of the Default and Dark appearances (plate full-bleed, like the mockup). */
const PREVIEW_SIZES = [1024, 128, 64, 32, 16] as const;

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
  for (const [name, svg] of Object.entries(iconAssets())) writeFileSync(path.join(ICON_DOC, 'Assets', name), svg);
  writeFileSync(path.join(ICON_DOC, 'icon.json'), `${JSON.stringify(iconDocument(), null, 2)}\n`);
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
    for (const rendition of ['Default', 'Dark'] as const) {
      for (const size of PREVIEW_SIZES) render(ictool, rendition, path.join(previews, `${rendition}-${size}.png`), size);
    }
  }
  console.log(`wrote ${path.relative(REPO_ROOT, ICON_DOC)}, ${path.relative(REPO_ROOT, ICNS)}, ${path.relative(REPO_ROOT, PNG)}` +
    (previews ? ` and ${RENDITIONS.length + 2 * PREVIEW_SIZES.length} previews in ${previews}` : ''));
}

main(process.argv.slice(2));
