import { ACCENTS, BASES, DENSITIES, type AccentPref, type BasePref, type DensityPref } from '../state/appearance';

/**
 * Routes of the dev-only design board, all behind `#design-board`:
 *   #design-board?layer=1|3|4                          the canvas (iframes laid out like a board)
 *   #design-board/frame?theme=&size=&base=&accent=&density=      layers 1–2 in one theme and text size
 *   #design-board/pattern?id=&theme=&size=&base=&accent=&density= one product pattern (layer 3)
 *   #design-board/screen?id=&w=&theme=&size=&base=&accent=&density= one whole screen (layer 4)
 * Every frame is a URL of its own, so the screenshot script can open it directly.
 */

export type BoardTheme = 'light' | 'dark';
export type BoardSize = 's' | 'm' | 'l';
/** Canvas layers: 1 = layers 1–2 (foundations, primitives), 3 = patterns, 4 = screens. */
export type BoardLayer = 1 | 3 | 4;

export interface BoardLook {
  theme: BoardTheme;
  size: BoardSize;
  base: BasePref;
  accent: AccentPref;
  density: DensityPref;
}

/** Window sizes of layer 4 (DESIGN-SYSTEM.md «Dev board»): the width decides the height. */
export const SCREEN_SIZES = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 820, h: 700 },
] as const;
export type ScreenWidth = (typeof SCREEN_SIZES)[number]['w'];

export const THEMES: readonly BoardTheme[] = ['light', 'dark'];
export const SIZES: readonly BoardSize[] = ['s', 'm', 'l'];

export const DEFAULT_LOOK: BoardLook = { theme: 'light', size: 'm', base: 'milk', accent: 'ink', density: 'comfortable' };

export type BoardRoute =
  | { kind: 'canvas'; layer: BoardLayer }
  | ({ kind: 'frame' } & BoardLook)
  | ({ kind: 'pattern'; id: string } & BoardLook)
  | ({ kind: 'screen'; id: string; w: ScreenWidth; h: number } & BoardLook);

const oneOf = <T extends string>(v: string | null, all: readonly T[], fallback: T): T =>
  v !== null && (all as readonly string[]).includes(v) ? (v as T) : fallback;

function readLook(q: URLSearchParams): BoardLook {
  return {
    theme: oneOf(q.get('theme'), THEMES, DEFAULT_LOOK.theme),
    size: oneOf(q.get('size'), SIZES, DEFAULT_LOOK.size),
    base: oneOf(q.get('base'), BASES.map((b) => b.value), DEFAULT_LOOK.base),
    accent: oneOf(q.get('accent'), ACCENTS.map((a) => a.value), DEFAULT_LOOK.accent),
    density: oneOf(q.get('density'), DENSITIES.map((d) => d.value), DEFAULT_LOOK.density),
  };
}

/** An id of the registry: lowercase words joined by dashes; anything else is no id. */
const readId = (v: string | null) => (v && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) ? v : '');

export function parseBoardRoute(hash: string): BoardRoute | null {
  if (!hash.startsWith('#design-board')) return null;
  const [path = '', query = ''] = hash.slice(1).split('?');
  const q = new URLSearchParams(query);
  if (path === 'design-board/frame') return { kind: 'frame', ...readLook(q) };
  if (path === 'design-board/pattern') return { kind: 'pattern', id: readId(q.get('id')), ...readLook(q) };
  if (path === 'design-board/screen') {
    const size = SCREEN_SIZES.find((s) => String(s.w) === q.get('w')) ?? SCREEN_SIZES[0];
    return { kind: 'screen', id: readId(q.get('id')), w: size.w, h: size.h, ...readLook(q) };
  }
  const layer = Number(q.get('layer'));
  return { kind: 'canvas', layer: layer === 3 || layer === 4 ? layer : 1 };
}

const lookQuery = (look: BoardLook) =>
  `theme=${look.theme}&size=${look.size}&base=${look.base}&accent=${look.accent}&density=${look.density}`;

export const frameHash = (look: BoardLook) => `#design-board/frame?${lookQuery(look)}`;
export const patternHash = (id: string, look: BoardLook) => `#design-board/pattern?id=${id}&${lookQuery(look)}`;
export const screenHash = (id: string, w: ScreenWidth, look: BoardLook) => `#design-board/screen?id=${id}&w=${w}&${lookQuery(look)}`;
export const canvasHash = (layer: BoardLayer) => (layer === 1 ? '#design-board' : `#design-board?layer=${layer}`);

/** Put a frame's look on <html>, where the tokens read it (the app's ThemeSync does the same from prefs). */
export function applyLook(html: HTMLElement, look: BoardLook): void {
  html.dataset.kbUi = '';
  html.dataset.theme = look.theme;
  html.dataset.textSize = look.size;
  html.dataset.base = look.base;
  html.dataset.accent = look.accent;
  html.dataset.density = look.density;
}
