/**
 * Colour maths for the design board: parse what `getComputedStyle` returns, composite, and measure
 * WCAG 2.x contrast and OKLCH lightness/hue. Pure; no DOM.
 */

/** Channels 0..1, alpha 0..1, sRGB. */
export interface Rgba { r: number; g: number; b: number; a: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function num(part: string, scale: number): number {
  const p = part.trim();
  if (p.endsWith('%')) return parseFloat(p) / 100;
  return parseFloat(p) / scale;
}

function channels(body: string): string[] {
  // "1, 2, 3, 0.5" | "1 2 3 / 0.5"
  return body.replace('/', ' ').split(/[\s,]+/).filter(Boolean);
}

function fromOklch(l: number, c: number, hDeg: number, a: number): Rgba {
  const h = (hDeg * Math.PI) / 180;
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const enc = (v: number) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return { r: enc(lin[0]!), g: enc(lin[1]!), b: enc(lin[2]!), a };
}

/** Reads #hex, rgb()/rgba() (comma or space syntax), color(srgb …), oklch(…), transparent. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 1 };
  }
  const fn = /^([a-z]+)\((.*)\)$/.exec(s);
  if (!fn) return null;
  const [, name, body] = fn;
  if (name === 'rgb' || name === 'rgba') {
    const p = channels(body!);
    if (p.length < 3) return null;
    return { r: num(p[0]!, 255), g: num(p[1]!, 255), b: num(p[2]!, 255), a: p[3] === undefined ? 1 : num(p[3], 1) };
  }
  if (name === 'color') {
    const p = channels(body!);
    if (p[0] !== 'srgb' || p.length < 4) return null;
    return { r: num(p[1]!, 1), g: num(p[2]!, 1), b: num(p[3]!, 1), a: p[4] === undefined ? 1 : num(p[4], 1) };
  }
  if (name === 'oklch') {
    const p = channels(body!);
    if (p.length < 3) return null;
    const l = num(p[0]!, 1);
    const c = p[1]!.endsWith('%') ? (parseFloat(p[1]!) / 100) * 0.4 : parseFloat(p[1]!);
    const h = p[2] === 'none' ? 0 : parseFloat(p[2]!);
    return fromOklch(l, c, h, p[3] === undefined ? 1 : num(p[3], 1));
  }
  return null;
}

/** `fg` painted over `bg` (bg alpha is taken as 1: board backgrounds are opaque surfaces). */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function luminance(c: Rgba): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio of `fg` (composited over `bg`) against `bg`. */
export function contrast(fg: Rgba, bg: Rgba): number {
  const base = { ...bg, a: 1 };
  const a = luminance(over(fg, base));
  const b = luminance(base);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLCH of an opaque colour. `h` is null for near-greys (chroma < 0.02), where hue means nothing. */
export function oklch(c: Rgba): { l: number; c: number; h: number | null } {
  const r = lin(c.r);
  const g = lin(c.g);
  const b = lin(c.b);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const chroma = Math.hypot(A, B);
  const hue = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: chroma, h: chroma < 0.02 ? null : (hue + 360) % 360 };
}

/** Shortest angle between two hues, degrees; null if either is a grey. */
export function hueDistance(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function toHex(c: Rgba): string {
  const h = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a) : ''}`;
}

/**
 * A colour token as `el` sees it. A plain value (`#hex`, `rgb()`) is read directly; anything the
 * cascade has to compute first (`light-dark()`, `color-mix()`, `var()` chains) is painted on a
 * hidden probe inside `el` and read back — `getPropertyValue` returns such values unresolved.
 * Null when neither works (jsdom without the token).
 */
export function cssColor(el: Element, name: string): Rgba | null {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const direct = raw ? parseColor(raw) : null;
  if (direct) return direct;
  if (!raw) return null;
  const probe = el.ownerDocument.createElement('i');
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none';
  probe.style.backgroundColor = `var(${name})`;
  el.appendChild(probe);
  const resolved = parseColor(getComputedStyle(probe).backgroundColor);
  probe.remove();
  return resolved;
}

/** `rgb()/rgba()` text of a colour, for canvas fill styles. */
export function toCss(c: Rgba): string {
  const v = (x: number) => Math.round(clamp01(x) * 255);
  return c.a < 1 ? `rgba(${v(c.r)}, ${v(c.g)}, ${v(c.b)}, ${+c.a.toFixed(3)})` : `rgb(${v(c.r)}, ${v(c.g)}, ${v(c.b)})`;
}
