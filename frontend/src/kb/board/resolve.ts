import { useLayoutEffect, useState } from 'react';
import { contrast, hueDistance, oklch, parseColor, toHex, type Rgba } from '../ui/color';

/**
 * Resolves `--kb-*` colour tokens to real colours the way the app sees them: each token is painted
 * as a background on a hidden probe and read back with getComputedStyle (custom properties
 * themselves stay unresolved strings, and color-mix/light-dark only exist after cascade).
 * In jsdom nothing resolves: every value is null and the board shows «—».
 */
export function useResolvedColors(names: readonly string[]): Map<string, Rgba | null> {
  const [map, setMap] = useState<Map<string, Rgba | null>>(() => new Map());
  const key = names.join('|');
  useLayoutEffect(() => {
    const root = document.createElement('div');
    root.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
    document.body.appendChild(root);
    const out = new Map<string, Rgba | null>();
    for (const name of names) {
      const probe = document.createElement('i');
      probe.style.backgroundColor = `var(${name})`;
      root.appendChild(probe);
      out.set(name, parseColor(getComputedStyle(probe).backgroundColor));
    }
    root.remove();
    setMap(out);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return map;
}

export const fmtHex = (c: Rgba | null | undefined) => (c ? toHex(c) : '—');

export function ratio(fg: Rgba | null | undefined, bg: Rgba | null | undefined): number | null {
  return fg && bg ? contrast(fg, bg) : null;
}

export function lightness(c: Rgba | null | undefined): number | null {
  return c ? oklch(c).l : null;
}

export function hue(c: Rgba | null | undefined): number | null {
  return c ? oklch(c).h : null;
}

export { hueDistance };
