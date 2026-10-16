/**
 * The SKAZ app icon as an Icon Composer document (decision 38: «Роща + цветные корни»).
 *
 * Pure data, no I/O: `scripts/make-icon.mts` writes what this module describes into
 * `build/icon.icon` and renders it with `ictool`. Composition, back to front:
 *   - the plate: milk gradient (Default) or graphite gradient (Dark);
 *   - pixel roots in the three folder colours (blue / purple / olive). An Icon Composer
 *     layer has a single fill, and that fill ignores the SVG's own opacity, so the roots
 *     are split by colour and by depth band; each layer carries its band's opacity;
 *   - the grove: two smaller crowns behind the tree, blue on the left, purple on the right;
 *   - the tree: crown «Облако» and trunk in graphite (Default) or milk (Dark).
 * Clear and Tinted appearances are derived by macOS from these layers (see `fill`).
 */
import { CANVAS, CROWN_CIRCLES, ROOT_CELLS, TRUNK_PATH } from './treeGeometry.ts';
import type { RootCell } from './treeGeometry.ts';

export type FolderColour = 'blue' | 'purple' | 'olive';
export const FOLDER_COLOURS: readonly FolderColour[] = ['blue', 'purple', 'olive'];

interface Appearance {
  /** Plate gradient, top-left to bottom-right. */
  readonly plate: readonly [string, string];
  /** Crown and trunk. */
  readonly tree: string;
  /** Folder colours: grove crowns and roots. */
  readonly folders: Readonly<Record<FolderColour, string>>;
}

/** Decision 38 palette (mockup `icon-final-v36.html`, `const T`). */
export const APP_ICON_PALETTE: { readonly default: Appearance; readonly dark: Appearance } = {
  default: {
    plate: ['#FFFFFB', '#E9E7DF'],
    tree: '#2C2E31',
    folders: { blue: '#2F62B0', purple: '#7046B8', olive: '#5A7420' },
  },
  dark: {
    plate: ['#33363A', '#1A1B1D'],
    tree: '#F9F8F3',
    folders: { blue: '#8FB4F2', purple: '#BFA4F4', olive: '#B8D07A' },
  },
};

/** Grove crowns: the main crown scaled ×0.72 about (512, 400), shifted ±190 px sideways and 40 px down. */
export const GROVE = { scale: 0.72, offset: 190, drop: 40, pivot: [512, 400] as const } as const;

type Circle = readonly [number, number, number];

/** One grove crown: the main crown's circles moved to the left (-1) or right (+1). */
export function groveCrown(side: -1 | 1): Circle[] {
  const [px, py] = GROVE.pivot;
  return CROWN_CIRCLES.map(([cx, cy, r]) => [
    round(px + side * GROVE.offset + GROVE.scale * (cx - px)),
    round(py + GROVE.drop + GROVE.scale * (cy - py)),
    round(GROVE.scale * r),
  ] as const);
}

/** The grove: blue crown on the left, purple on the right. */
export const GROVE_CROWNS: ReadonlyArray<{ readonly colour: FolderColour; readonly circles: readonly Circle[] }> = [
  { colour: 'blue', circles: groveCrown(-1) },
  { colour: 'purple', circles: groveCrown(1) },
];

/** Root pixels take the folder colours in turn (blue, purple, olive, blue, …), as in the mockup. */
export function rootColour(index: number): FolderColour {
  return FOLDER_COLOURS[index % FOLDER_COLOURS.length]!;
}

/** Deeper pixels are fainter (1 − 0.38·depth); the fade is quantised into this many bands. */
export const ROOT_DEPTH_BANDS = 4;

export function rootBand(cell: RootCell): number {
  return Math.round(cell.depth * (ROOT_DEPTH_BANDS - 1));
}

export function rootBandOpacity(band: number): number {
  return round(1 - (0.38 * band) / (ROOT_DEPTH_BANDS - 1));
}

export interface RootLayer {
  readonly name: string;
  readonly colour: FolderColour;
  readonly opacity: number;
  readonly cells: readonly RootCell[];
}

/** One layer per folder colour and depth band, empty ones skipped. */
export const ROOT_LAYERS: readonly RootLayer[] = FOLDER_COLOURS.flatMap((colour) =>
  Array.from({ length: ROOT_DEPTH_BANDS }, (_, band) => ({
    name: `roots-${colour}-${band}`,
    colour,
    opacity: rootBandOpacity(band),
    cells: ROOT_CELLS.filter((cell, index) => rootColour(index) === colour && rootBand(cell) === band),
  })).filter((layer) => layer.cells.length > 0),
);

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">${body}</svg>\n`;
}

const circles = (list: readonly Circle[]) => list.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('');

/** Layer artwork is white; Icon Composer recolours every layer per appearance. */
export function treeSvg(): string {
  return svg(`<g fill="#ffffff">${circles(CROWN_CIRCLES)}<path d="${TRUNK_PATH}"/></g>`);
}

export function groveSvg(colour: FolderColour): string {
  const crown = GROVE_CROWNS.find((c) => c.colour === colour);
  if (!crown) throw new Error(`no grove crown in ${colour}`);
  return svg(`<g fill="#ffffff">${circles(crown.circles)}</g>`);
}

export function rootsSvg(layer: RootLayer): string {
  const pixels = layer.cells.map(
    (c) => `<rect x="${c.x}" y="${c.y}" width="${c.size}" height="${c.size}" rx="2"/>`,
  ).join('');
  return svg(`<g fill="#ffffff">${pixels}</g>`);
}

/** `#RRGGBB` → Icon Composer's `srgb:r,g,b,a`. */
export function srgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return `srgb:${r!.toFixed(5)},${g!.toFixed(5)},${b!.toFixed(5)},1.00000`;
}

type Pick = (appearance: Appearance) => string;

/**
 * Layer fill per appearance. Clear and Tinted turn the artwork monochrome by brightness; fed the
 * Default colours they would draw a dark tree behind lighter crowns, so they take the Dark ones
 * (milk tree brightest, grove and roots below it), the hierarchy of the coloured icon.
 */
function fill(pick: Pick) {
  const dark = { solid: srgb(pick(APP_ICON_PALETTE.dark)) };
  return [
    { value: { solid: srgb(pick(APP_ICON_PALETTE.default)) } },
    { appearance: 'dark', value: dark },
    { appearance: 'tinted', value: dark },
  ];
}

/** File name → SVG text for `build/icon.icon/Assets`. */
export function iconAssets(): Record<string, string> {
  const assets: Record<string, string> = { 'tree.svg': treeSvg() };
  for (const { colour } of GROVE_CROWNS) assets[`grove-${colour}.svg`] = groveSvg(colour);
  for (const layer of ROOT_LAYERS) assets[`${layer.name}.svg`] = rootsSvg(layer);
  return assets;
}

/** `build/icon.icon/icon.json`. Groups and layers are listed front to back. */
export function iconDocument() {
  return {
    'fill-specializations': [
      { value: { 'linear-gradient': APP_ICON_PALETTE.default.plate.map(srgb) } },
      { appearance: 'dark', value: { 'linear-gradient': APP_ICON_PALETTE.dark.plate.map(srgb) } },
    ],
    groups: [
      {
        name: 'Tree',
        layers: [{ name: 'tree', 'image-name': 'tree.svg', glass: true, 'fill-specializations': fill((a) => a.tree) }],
        shadow: { kind: 'neutral', opacity: 0.5 },
        translucency: { enabled: false, value: 0 },
        specular: true,
      },
      {
        name: 'Grove',
        layers: GROVE_CROWNS.map(({ colour }) => ({
          name: `grove-${colour}`, 'image-name': `grove-${colour}.svg`, glass: true,
          'fill-specializations': fill((a) => a.folders[colour]),
        })),
        shadow: { kind: 'neutral', opacity: 0.3 },
        translucency: { enabled: false, value: 0 },
        specular: true,
      },
      {
        name: 'Roots',
        layers: ROOT_LAYERS.map(({ name, colour, opacity }) => ({
          name, 'image-name': `${name}.svg`, glass: false, opacity,
          'fill-specializations': fill((a) => a.folders[colour]),
        })),
        shadow: { kind: 'neutral', opacity: 0.3 },
        translucency: { enabled: false, value: 0 },
        specular: false,
      },
    ],
    'supported-platforms': { squares: 'shared' },
  };
}
