export interface WeightedItem {
  weight: number;
}

export type TreemapRect<T> = T & {
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * Pure squarified treemap layout (Bruls, Huizing, van Wijk).
 * Lays out positive-weight items inside `[x, y, w, h]` minimizing aspect ratio distortion.
 */
export function squarify<T extends WeightedItem>(
  items: readonly T[],
  startX: number,
  startY: number,
  startW: number,
  startH: number,
): Array<TreemapRect<T>> {
  const positive = items.filter((item) => item.weight > 0);
  if (positive.length === 0 || startW <= 0 || startH <= 0) {
    return [];
  }

  const out: Array<TreemapRect<T>> = [];
  const rest = positive.slice();
  const total = rest.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return [];

  let x = startX;
  let y = startY;
  let w = startW;
  let h = startH;
  const k = (w * h) / total;
  let row: T[] = [];

  const worst = (r: readonly T[], side: number): number => {
    if (r.length === 0 || side <= 0) return Number.POSITIVE_INFINITY;
    let sum = 0;
    let maxArea = Number.NEGATIVE_INFINITY;
    let minArea = Number.POSITIVE_INFINITY;
    for (const item of r) {
      const area = item.weight * k;
      sum += area;
      if (area > maxArea) maxArea = area;
      if (area < minArea) minArea = area;
    }
    if (sum <= 0 || minArea <= 0) return Number.POSITIVE_INFINITY;
    const sideSq = side * side;
    const sumSq = sum * sum;
    return Math.max((sideSq * maxArea) / sumSq, sumSq / (sideSq * minArea));
  };

  const layoutRow = (): void => {
    const rowArea = row.reduce((sum, item) => sum + item.weight * k, 0);
    if (w >= h) {
      const colW = h > 0 ? rowArea / h : 0;
      let cy = y;
      for (const item of row) {
        const ch = colW > 0 ? (item.weight * k) / colW : 0;
        out.push({ ...item, x, y: cy, w: colW, h: ch });
        cy += ch;
      }
      x += colW;
      w = Math.max(0, w - colW);
    } else {
      const rowH = w > 0 ? rowArea / w : 0;
      let cx = x;
      for (const item of row) {
        const cw = rowH > 0 ? (item.weight * k) / rowH : 0;
        out.push({ ...item, x: cx, y, w: cw, h: rowH });
        cx += cw;
      }
      y += rowH;
      h = Math.max(0, h - rowH);
    }
  };

  while (rest.length > 0) {
    const side = Math.min(w, h);
    const next = rest[0]!;
    if (row.length === 0 || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      rest.shift();
    } else {
      layoutRow();
      row = [];
    }
  }
  if (row.length > 0) {
    layoutRow();
  }
  return out;
}
