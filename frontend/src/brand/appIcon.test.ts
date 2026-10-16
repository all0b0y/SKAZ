import {
  APP_ICON_PALETTE, FOLDER_COLOURS, GROVE, GROVE_CROWNS, ROOT_LAYERS, iconAssets, iconDocument, rootColour, srgb,
} from './appIcon';
import { CROWN_CIRCLES, ROOT_CELLS } from './treeGeometry';

type Fill = { appearance?: string; value: { solid?: string; 'linear-gradient'?: string[] } };
type Layer = { name: string; 'image-name': string; opacity?: number; 'fill-specializations': Fill[] };
type Group = { name: string; layers: Layer[] };

const doc = iconDocument() as unknown as { 'fill-specializations': Fill[]; groups: Group[] };
const group = (name: string) => doc.groups.find((g) => g.name === name)!;
const solid = (layer: Layer, appearance?: string) =>
  layer['fill-specializations'].find((f) => f.appearance === appearance)?.value.solid;

describe('SKAZ app icon (decision 38: «Роща + цветные корни»)', () => {
  it('uses the decision 38 palette in both appearances', () => {
    expect(APP_ICON_PALETTE).toEqual({
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
    });
  });

  it('paints the plate milk by default and graphite in Dark', () => {
    const plate = doc['fill-specializations'];
    expect(plate.find((f) => !f.appearance)?.value['linear-gradient']).toEqual(['#FFFFFB', '#E9E7DF'].map(srgb));
    expect(plate.find((f) => f.appearance === 'dark')?.value['linear-gradient']).toEqual(['#33363A', '#1A1B1D'].map(srgb));
  });

  it('stacks tree over grove over roots', () => {
    expect(doc.groups.map((g) => g.name)).toEqual(['Tree', 'Grove', 'Roots']);
    const [tree] = group('Tree').layers;
    expect(solid(tree!)).toBe(srgb('#2C2E31'));
    expect(solid(tree!, 'dark')).toBe(srgb('#F9F8F3'));
  });

  it('puts two smaller crowns behind the tree: blue on the left, purple on the right', () => {
    expect(GROVE).toMatchObject({ scale: 0.72, offset: 190 });
    expect(GROVE_CROWNS.map((c) => c.colour)).toEqual(['blue', 'purple']);
    const [left, right] = GROVE_CROWNS;
    const centre = (circles: readonly (readonly [number, number, number])[]) =>
      circles.reduce((sum, [x]) => sum + x, 0) / circles.length;
    const main = centre(CROWN_CIRCLES);
    expect(centre(left!.circles)).toBeCloseTo(main - 190, 0);
    expect(centre(right!.circles)).toBeCloseTo(main + 190, 0);
    for (const crown of GROVE_CROWNS) {
      crown.circles.forEach(([, , r], i) => expect(r).toBeCloseTo(CROWN_CIRCLES[i]![2] * 0.72, 1));
    }
    const grove = group('Grove').layers;
    expect(grove.map((l) => [solid(l), solid(l, 'dark')])).toEqual([
      [srgb('#2F62B0'), srgb('#8FB4F2')],
      [srgb('#7046B8'), srgb('#BFA4F4')],
    ]);
  });

  it('splits every root pixel into exactly one layer of its folder colour', () => {
    const covered = ROOT_LAYERS.flatMap((layer) => layer.cells);
    expect(covered).toHaveLength(ROOT_CELLS.length);
    expect(new Set(covered).size).toBe(ROOT_CELLS.length);
    ROOT_CELLS.forEach((cell, index) => {
      const layer = ROOT_LAYERS.find((l) => l.cells.includes(cell))!;
      expect(layer.colour).toBe(rootColour(index));
    });
    expect(new Set(ROOT_LAYERS.map((l) => l.colour))).toEqual(new Set(FOLDER_COLOURS));
  });

  it('colours the root layers with the three folder colours and fades them with depth', () => {
    for (const layer of group('Roots').layers) {
      const colour = ROOT_LAYERS.find((l) => l.name === layer.name)!.colour;
      expect(solid(layer)).toBe(srgb(APP_ICON_PALETTE.default.folders[colour]));
      expect(solid(layer, 'dark')).toBe(srgb(APP_ICON_PALETTE.dark.folders[colour]));
    }
    const opacities = [...new Set(ROOT_LAYERS.map((l) => l.opacity))].sort((a, b) => a - b);
    expect(opacities[0]).toBeCloseTo(0.62, 2);
    expect(opacities.at(-1)).toBe(1);
    for (const layer of ROOT_LAYERS) {
      for (const cell of layer.cells) expect(Math.abs(cell.opacity - layer.opacity)).toBeLessThanOrEqual(0.07);
    }
  });

  it('gives Clear and Tinted the light tree, so it stays the brightest shape', () => {
    for (const g of doc.groups) for (const layer of g.layers) expect(solid(layer, 'tinted')).toBe(solid(layer, 'dark'));
  });

  it('ships an SVG for every layer and nothing else', () => {
    const assets = iconAssets();
    const used = doc.groups.flatMap((g) => g.layers.map((l) => l['image-name']));
    expect(Object.keys(assets).sort()).toEqual([...used].sort());
    for (const svgText of Object.values(assets)) expect(svgText).toMatch(/^<svg [^>]*viewBox="0 0 1024 1024"/);
    // Icon Composer ignores opacity inside a filled layer; the fade lives on the layer.
    for (const layer of ROOT_LAYERS) expect(assets[`${layer.name}.svg`]).not.toContain('opacity');
  });
});
