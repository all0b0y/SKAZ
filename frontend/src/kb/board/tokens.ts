/** Inventory of `styles/tokens.css`: which custom properties it declares, and how. */

export type TokenMap = Map<string, string>;

export interface TokenBlocks {
  /** `html[data-kb-ui] { … }` — every token; colours as `light-dark(light, dark)` where they differ. */
  light: TokenMap;
  textSize: Partial<Record<'s' | 'l', TokenMap>>;
  /** Selectors other than the base / text-size ones that declare tokens (should be none). */
  stray: string[];
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function declarations(body: string): TokenMap {
  const map: TokenMap = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1]!, m[2]!.trim().replace(/\s+/g, ' '));
  return map;
}

/** The body of the first `{…}` after `from`, braces balanced. */
function blockAfter(css: string, from: number): { body: string; end: number } | null {
  const open = css.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

export function parseTokenBlocks(raw: string): TokenBlocks {
  const css = stripComments(raw);
  const result: TokenBlocks = { light: new Map(), textSize: {}, stray: [] };
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    const block = blockAfter(css, i);
    if (!block) break;
    const decls = declarations(block.body);
    const size = /data-text-size='([sl])'/.exec(head);
    if (head === 'html[data-kb-ui]') result.light = decls;
    else if (size) result.textSize[size[1] as 's' | 'l'] = decls;
    else if (decls.size > 0) result.stray.push(head);
    i = block.end;
  }
  return result;
}

/** The value a token has in one theme: picks a side of every `light-dark(a, b)` (not nested). */
export function themeValue(value: string, theme: 'light' | 'dark'): string {
  return value.replace(
    /light-dark\(((?:[^(),]|\([^()]*\))+),\s*((?:[^(),]|\([^()]*\))+)\)/g,
    (_m, a: string, b: string) => (theme === 'light' ? a : b).trim(),
  );
}

export type TokenGroup = 'color' | 'type' | 'radius' | 'space' | 'shadow' | 'font' | 'chrome';

const CHROME = new Set(['--kb-titlebar-h', '--kb-head-h', '--kb-rail-w', '--kb-icon', '--kb-icon-lg']);

export function groupOf(name: string): TokenGroup {
  if (name.startsWith('--t-')) return 'type';
  if (name.startsWith('--kb-r-')) return 'radius';
  if (name.startsWith('--kb-sp-') || name === '--kb-density') return 'space';
  if (name.startsWith('--kb-shadow-')) return 'shadow';
  if (name.startsWith('--kb-font')) return 'font';
  if (CHROME.has(name)) return 'chrome';
  return 'color';
}

export function tokenGroups(map: TokenMap): Record<TokenGroup, string[]> {
  const out: Record<TokenGroup, string[]> = { color: [], type: [], radius: [], space: [], shadow: [], font: [], chrome: [] };
  for (const name of map.keys()) out[groupOf(name)].push(name);
  return out;
}
