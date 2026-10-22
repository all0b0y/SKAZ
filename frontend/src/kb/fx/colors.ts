/*
 * Effect colours come from the theme tokens, never hard-coded (FX-EFFECTS-SPEC «Global rules»):
 * ink = --kb-text, accent = --kb-fx-accent. Fallbacks are the light theme's values, used where no
 * stylesheet is loaded (tests) or a token is missing.
 */

export type Rgb = readonly [number, number, number];

export interface FxColors {
  ink: Rgb;
  accent: Rgb;
  /** Kept optional for compatibility: no painter uses the pane colour, so it is not read. */
  pane?: Rgb;
}

const FALLBACK = { ink: [44, 46, 49], accent: [74, 44, 32] } as const satisfies FxColors;

/** `#rgb`, `#rrggbb` or `rgb(a)(r, g, b…)` → Rgb; null when it can't be read. */
export function parseColor(value: string): Rgb | null {
  const s = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.split('').map((ch) => ch + ch).join('') : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

/** The effect palette as the element sees it (inherits the theme from html[data-kb-ui]). */
export function readFxColors(el: Element): FxColors {
  const cs = getComputedStyle(el);
  const read = (name: string, fallback: Rgb) => parseColor(cs.getPropertyValue(name)) ?? fallback;
  return {
    ink: read('--kb-text', FALLBACK.ink),
    accent: read('--kb-fx-accent', FALLBACK.accent),
  };
}

/** Linear blend a → b by k (0 = a, 1 = b). */
export function mixRgb(a: Rgb, b: Rgb, k: number): Rgb {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** A canvas fill style; alpha is clamped to [0, 1]. */
export function rgba(c: Rgb, a: number): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
