/**
 * Drift audit for the design board: values written by hand in the CSS instead of taken from
 * tokens.css — literal colours, font sizes, radii, shadows, and the px spacing actually in use.
 * Pure: takes file name → CSS text.
 */

export interface Literal { file: string; value: string }
export interface Tally { value: string; count: number; files: string[] }
export interface SpacingTally { value: string; count: number; onGrid: boolean }

export interface CssAudit {
  colors: Literal[];
  fontSizes: Tally[];
  radii: Tally[];
  spacing: SpacingTally[];
  /** Elevation box-shadows (with a blur) not taken from a `--kb-shadow-*` token. Rings and inset
   *  outlines (`0 0 0 2px …`, `inset …`) are outlines, not elevation, and are not counted. */
  shadows: number;
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/g;

function strip(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // var(--x, fallback): the fallback is not a hand-written use.
    .replace(/var\(\s*--[\w-]+\s*,[^()]*(?:\([^()]*\)[^()]*)*\)/g, 'var()');
}

function decls(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) out.push([m[1]!, m[2]!.trim()]);
  return out;
}

function tally(list: Array<{ value: string; file: string }>): Tally[] {
  const map = new Map<string, Tally>();
  for (const { value, file } of list) {
    const t = map.get(value) ?? { value, count: 0, files: [] };
    t.count += 1;
    if (!t.files.includes(file)) t.files.push(file);
    map.set(value, t);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function topLevelCommas(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < v.length; i += 1) {
    if (v[i] === '(') depth += 1;
    else if (v[i] === ')') depth -= 1;
    else if (v[i] === ',' && depth === 0) { out.push(v.slice(start, i)); start = i + 1; }
  }
  out.push(v.slice(start));
  return out;
}

function isElevation(value: string): boolean {
  if (value === 'none') return false;
  return topLevelCommas(value).some((layer) => {
    if (/\binset\b/.test(layer)) return false;
    let bare = layer;
    while (/\([^()]*\)/.test(bare)) bare = bare.replace(/\([^()]*\)/g, '');
    const lengths = bare.match(/-?\d*\.?\d+(px)?\b/g) ?? [];
    return lengths.length >= 3 && parseFloat(lengths[2]!) !== 0;
  });
}

const SPACING_PROPS = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;

export function auditCss(files: Record<string, string>): CssAudit {
  const colors: Literal[] = [];
  const fonts: Array<{ value: string; file: string }> = [];
  const radii: Array<{ value: string; file: string }> = [];
  const spacing = new Map<string, number>();
  let shadows = 0;
  for (const [file, raw] of Object.entries(files)) {
    const css = strip(raw);
    for (const [prop, value] of decls(css)) {
      if (prop.startsWith('--')) continue;
      for (const m of value.matchAll(COLOR_RE)) colors.push({ file, value: m[0] });
      if (prop === 'font-size' && /^\d/.test(value)) fonts.push({ value, file });
      if (prop === 'border-radius' && !value.includes('var(')) {
        for (const v of value.split(/\s+/)) if (/px$/.test(v) && !['0px', '1px', '999px'].includes(v)) radii.push({ value: v, file });
      }
      if (prop === 'box-shadow' && !value.includes('var(--kb-shadow') && isElevation(value)) shadows += 1;
      if (SPACING_PROPS.test(prop)) {
        for (const v of value.split(/\s+/)) if (/^-?\d+(\.\d+)?px$/.test(v) && parseFloat(v) !== 0) {
          const key = v.replace(/^-/, '');
          spacing.set(key, (spacing.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return {
    colors,
    fontSizes: tally(fonts),
    radii: tally(radii),
    spacing: [...spacing.entries()]
      .map(([value, count]) => ({ value, count, onGrid: parseFloat(value) % 4 === 0 }))
      .sort((a, b) => parseFloat(a.value) - parseFloat(b.value)),
    shadows,
  };
}
