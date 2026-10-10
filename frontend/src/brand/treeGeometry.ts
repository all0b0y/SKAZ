/**
 * Geometry of the SKAZ tree mark, shared by the app icon generator
 * (`scripts/make-icon.mts`) and the in-app tree (`components/brand`).
 *
 * Coordinates live on a 1024-unit square canvas. The crown and trunk are one
 * solid silhouette; the roots are grid-snapped squares that shrink and thin
 * out with depth; the "sap" cells trace pixel branches inside the crown for
 * the startup animation. Everything is deterministic (seeded), so the icon,
 * the app and the tests always draw the same tree.
 */

export const CANVAS = 1024;
/** Root pixel grid. */
export const GRID = 32;
/** Ground line: the trunk ends and the roots start here. */
export const GROUND = 608;
/** Depth at which roots have fully thinned out. */
export const DEEP = 944;
/** Finer grid for the sap that runs inside the trunk and crown. */
export const SAP_GRID = 26;
/** Tight box around crown + roots for in-app rendering. */
export const TREE_VIEWBOX = '140 70 744 890';

type Point = readonly [number, number];
interface Curve { readonly p0: Point; readonly c: Point; readonly p1: Point }

/** Crown circles (cx, cy, r): one cloud-shaped silhouette. */
export const CROWN_CIRCLES: ReadonlyArray<readonly [number, number, number]> = [
  [512, 232, 146], [352, 306, 124], [672, 306, 124], [292, 414, 92],
  [732, 414, 92], [430, 432, 108], [594, 432, 108], [512, 346, 170],
];
/** Trunk from inside the crown down to the ground, with a small flare. */
export const TRUNK_PATH = 'M480,470 L544,470 L551,560 Q555,598 580,608 L444,608 Q469,598 473,560 Z';

export interface RootCell {
  /** Top-left corner and side of the square. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** 0 just below the ground, 1 at full depth. */
  readonly depth: number;
  /** Resting opacity: deeper pixels are fainter. */
  readonly opacity: number;
  /** Detached fragment near a root tip. */
  readonly fragment: boolean;
}

export interface SapCell {
  /** Centre of the square. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** Order along the flow: trunk first, then outward along the branches. */
  readonly step: number;
}

function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bezier({ p0, c, p1 }: Curve, t: number): [number, number] {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
}

function bezierTangent({ p0, c, p1 }: Curve, t: number): [number, number] {
  const u = 1 - t;
  return [2 * u * (c[0] - p0[0]) + 2 * t * (p1[0] - c[0]), 2 * u * (c[1] - p0[1]) + 2 * t * (p1[1] - c[1])];
}

function curveLength(curve: Curve): number {
  let length = 0;
  let previous: readonly [number, number] = curve.p0;
  for (let i = 1; i <= 24; i++) {
    const point = bezier(curve, i / 24);
    length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return length;
}

interface Root extends Curve { readonly width: number }
interface Branch { readonly parent: number; readonly t: number; readonly c: Point; readonly p1: Point }

const MAIN_ROOTS: readonly Root[] = [
  { p0: [512, 622], c: [518, 780], p1: [500, 936], width: 2 },
  { p0: [500, 622], c: [452, 700], p1: [330, 870], width: 2 },
  { p0: [524, 622], c: [572, 700], p1: [694, 870], width: 2 },
  { p0: [492, 618], c: [392, 646], p1: [218, 742], width: 2 },
  { p0: [532, 618], c: [632, 646], p1: [806, 742], width: 2 },
];
const SIDE_ROOTS: ReadonlyArray<Branch & { readonly width: number }> = [
  { parent: 1, t: 0.55, c: [318, 850], p1: [262, 936], width: 1 },
  { parent: 2, t: 0.55, c: [706, 850], p1: [762, 936], width: 1 },
  { parent: 0, t: 0.45, c: [470, 860], p1: [426, 940], width: 1 },
  { parent: 0, t: 0.45, c: [556, 860], p1: [598, 940], width: 1 },
  { parent: 3, t: 0.6, c: [240, 776], p1: [170, 852], width: 1 },
  { parent: 4, t: 0.6, c: [784, 776], p1: [854, 852], width: 1 },
];

function buildRoots(): RootCell[] {
  const random = rng(7);
  const depthByCell = new Map<string, number>();
  const mark = (x: number, y: number) => {
    const cx = Math.floor(x / GRID);
    const cy = Math.floor(y / GRID);
    if (cy * GRID < GROUND) return;
    const depth = Math.min(1, Math.max(0, ((cy + 0.5) * GRID - GROUND) / (DEEP - GROUND)));
    const key = `${cx},${cy}`;
    const known = depthByCell.get(key);
    if (known === undefined || known > depth) depthByCell.set(key, depth);
  };

  const roots: Root[] = [...MAIN_ROOTS];
  for (const side of SIDE_ROOTS) {
    const parent = roots[side.parent]!;
    roots.push({ p0: bezier(parent, side.t), c: side.c, p1: side.p1, width: side.width });
  }
  for (const root of roots) {
    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      const [x, y] = bezier(root, t);
      const [dx, dy] = bezierTangent(root, t);
      const length = Math.hypot(dx, dy) || 1;
      const width = Math.max(1, Math.round(root.width * (1 - t * 0.9)));
      for (let lane = 0; lane < width; lane++) {
        const offset = (lane - (width - 1) / 2) * GRID * 0.95;
        mark(x - (dy / length) * offset, y + (dx / length) * offset);
      }
    }
  }

  // Fragmentation: deeper cells drop out more often (string order keeps the seed stable).
  const kept: Array<{ cx: number; cy: number; depth: number; fragment: boolean }> = [];
  for (const key of [...depthByCell.keys()].sort()) {
    const depth = depthByCell.get(key)!;
    if (depth > 0.12 && random() > 1 - 0.5 * Math.pow(depth, 1.3)) continue;
    const [cx = 0, cy = 0] = key.split(',').map(Number);
    kept.push({ cx, cy, depth, fragment: false });
  }
  // A few detached fragments around the deeper cells.
  for (const cell of kept.filter((c) => c.depth > 0.5)) {
    if (random() < 0.4) {
      const cx = cell.cx + (random() < 0.5 ? -1 : 1) * (1 + Math.floor(random() * 2));
      const cy = cell.cy + Math.floor(random() * 2);
      if (!depthByCell.has(`${cx},${cy}`) && (cy + 1) * GRID <= DEEP + 24) {
        kept.push({ cx, cy, depth: Math.min(1, cell.depth + 0.15), fragment: true });
      }
    }
  }

  return kept.map(({ cx, cy, depth, fragment }) => {
    const size = Number((GRID * (0.84 - 0.46 * depth) * (fragment ? 0.7 : 1)).toFixed(1));
    return {
      x: Number(((cx + 0.5) * GRID - size / 2).toFixed(1)),
      y: Number(((cy + 0.5) * GRID - size / 2).toFixed(1)),
      size,
      depth,
      opacity: Number((1 - 0.38 * depth).toFixed(3)),
      fragment,
    };
  });
}

const SAP_BRANCHES: readonly Curve[] = [
  { p0: [512, 470], c: [512, 370], p1: [512, 214] },
  { p0: [512, 486], c: [456, 404], p1: [350, 314] },
  { p0: [512, 486], c: [568, 404], p1: [674, 314] },
  { p0: [508, 506], c: [416, 474], p1: [290, 420] },
  { p0: [516, 506], c: [608, 474], p1: [734, 420] },
];
const SAP_TWIGS: readonly Branch[] = [
  { parent: 0, t: 0.55, c: [466, 252], p1: [414, 184] },
  { parent: 0, t: 0.55, c: [558, 252], p1: [610, 184] },
  { parent: 1, t: 0.6, c: [322, 326], p1: [264, 300] },
  { parent: 2, t: 0.6, c: [702, 326], p1: [760, 300] },
  { parent: 3, t: 0.5, c: [372, 476], p1: [400, 500] },
  { parent: 4, t: 0.5, c: [652, 476], p1: [624, 500] },
];

function buildSap(): { trunk: SapCell[]; branches: SapCell[]; tips: SapCell[] } {
  const seen = new Set<string>();
  const trunk: SapCell[] = [];
  const branches: SapCell[] = [];
  const tips: SapCell[] = [];
  const add = (list: SapCell[], x: number, y: number, step: number, size: number): SapCell | null => {
    const cx = Math.floor(x / SAP_GRID);
    const cy = Math.floor(y / SAP_GRID);
    const key = `${cx},${cy}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const cell = { x: (cx + 0.5) * SAP_GRID, y: (cy + 0.5) * SAP_GRID, step, size };
    list.push(cell);
    return cell;
  };

  let step = 0;
  for (let y = 600; y >= 476; y -= SAP_GRID) add(trunk, 512, y, step++, 17);
  const trunkSteps = step;

  const curves: Array<Curve & { base: number }> = SAP_BRANCHES.map((branch) => ({ ...branch, base: trunkSteps }));
  for (const twig of SAP_TWIGS) {
    const parent = curves[twig.parent]!;
    curves.push({
      p0: bezier(parent, twig.t), c: twig.c, p1: twig.p1,
      base: parent.base + Math.round((twig.t * curveLength(parent)) / SAP_GRID),
    });
  }
  for (const curve of curves) {
    const length = curveLength(curve);
    const samples = Math.max(2, Math.ceil(length / (SAP_GRID * 0.6)));
    let last: SapCell | null = null;
    for (let i = 0; i <= samples; i++) {
      const [x, y] = bezier(curve, i / samples);
      const cell = add(branches, x, y, curve.base + Math.round((i * length) / samples / SAP_GRID), 15);
      if (cell) last = cell;
    }
    if (last) tips.push(last);
  }
  return { trunk, branches, tips };
}

export const ROOT_CELLS: readonly RootCell[] = buildRoots();
export const SAP: { readonly trunk: readonly SapCell[]; readonly branches: readonly SapCell[]; readonly tips: readonly SapCell[] } = buildSap();
