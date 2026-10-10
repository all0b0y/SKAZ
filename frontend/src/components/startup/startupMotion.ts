import { ROOT_CELLS, SAP } from '../../brand/treeGeometry';

/**
 * Startup motion, voice becoming knowledge: drops rise from the sound wave into the
 * roots, sap climbs the trunk, grows into pixel branches inside the crown and
 * scatters as sparks, then the cycle repeats while the backend starts.
 * Web Animations only; every function is a no-op where the API is missing.
 */

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** Roots never fully disappear between cycles. */
const ROOT_FLOOR = 0.3;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const canAnimate = (): boolean =>
  typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

const roots = (svg: SVGSVGElement) => Array.from(svg.querySelectorAll<SVGRectElement>('.tree-mark__roots rect'));
const sap = (svg: SVGSVGElement, part: 'trunk' | 'branch') =>
  Array.from(svg.querySelectorAll<SVGRectElement>(`.startup__sap [data-part="${part}"]`));
const bars = (wave: HTMLElement | null) => Array.from(wave?.querySelectorAll<HTMLElement>('span') ?? []);
const restingOpacity = (index: number) => ROOT_CELLS[index]?.opacity ?? 1;

function cancel(elements: Iterable<Element>): void {
  for (const element of elements) for (const animation of element.getAnimations()) animation.cancel();
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sparks(svg: SVGSVGElement, next: () => number): void {
  const layer = svg.querySelector('.startup__sparks');
  if (!layer) return;
  for (const tip of SAP.tips) {
    for (let k = 0; k < 3; k++) {
      const angle = next() * Math.PI * 2;
      const distance = 50 + next() * 90;
      const spark = document.createElementNS(SVG_NS, 'rect');
      spark.setAttribute('x', String(tip.x - 5.5));
      spark.setAttribute('y', String(tip.y - 5.5));
      spark.setAttribute('width', '11');
      spark.setAttribute('height', '11');
      spark.setAttribute('rx', '2');
      layer.appendChild(spark);
      const dx = (Math.cos(angle) * distance).toFixed(0);
      const dy = (Math.sin(angle) * distance - 30).toFixed(0);
      spark.animate(
        [{ opacity: 0.95, transform: 'none' }, { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.5)` }],
        { duration: 700 + next() * 400, delay: next() * 160, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
      ).onfinish = () => spark.remove();
    }
  }
}

/** One pass; returns its length so the caller can schedule the next one. */
function cycle(svg: SVGSVGElement, next: () => number, timers: number[]): number {
  const rootCells = roots(svg);
  const trunk = sap(svg, 'trunk');
  const branch = sap(svg, 'branch');
  cancel([...rootCells, ...trunk, ...branch]);

  const jitter = rootCells.map(() => next());
  const order = rootCells.map((_, index) => index)
    .sort((a, b) => (ROOT_CELLS[b]?.y ?? 0) - (ROOT_CELLS[a]?.y ?? 0) || (jitter[a] ?? 0) - (jitter[b] ?? 0));
  order.forEach((index, n) => rootCells[index]?.animate(
    [{ opacity: ROOT_FLOOR, transform: 'translateY(110px)' }, { opacity: restingOpacity(index), transform: 'none' }],
    { duration: 420, delay: n * 7, easing: EASE, fill: 'forwards' },
  ));

  const trunkStart = order.length * 7 + 260;
  trunk.forEach((cell, n) => cell.animate(
    [{ opacity: 0, transform: 'scale(0.3)' }, { opacity: 1, transform: 'none' }],
    { duration: 220, delay: trunkStart + n * 55, easing: EASE, fill: 'forwards' },
  ));
  const branchStart = trunkStart + SAP.trunk.length * 55;
  branch.forEach((cell, n) => cell.animate(
    [{ opacity: 0, transform: 'scale(0.2)' }, { opacity: 0.95, transform: 'none' }],
    { duration: 240, delay: branchStart + ((SAP.branches[n]?.step ?? 0) - SAP.trunk.length) * 34, easing: EASE, fill: 'forwards' },
  ));

  const lastStep = Math.max(...SAP.branches.map((cell) => cell.step)) - SAP.trunk.length;
  const sparksAt = branchStart + lastStep * 34 + 120;
  timers.push(window.setTimeout(() => sparks(svg, next), sparksAt));
  const fadeAt = sparksAt + 700;
  timers.push(window.setTimeout(() => {
    for (const cell of [...trunk, ...branch]) {
      cell.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 520, easing: 'ease', fill: 'forwards' });
    }
    rootCells.forEach((cell, index) => cell.animate(
      [{ opacity: restingOpacity(index) }, { opacity: ROOT_FLOOR }], { duration: 560, easing: 'ease', fill: 'forwards' },
    ));
  }, fadeAt));
  return fadeAt + 620;
}

/** Loop while the backend starts; returns a stop function. Reduced motion: still tree, wave only flickers. */
export function runStartup(svg: SVGSVGElement, wave: HTMLElement | null, reduced: boolean): () => void {
  if (!canAnimate()) return () => undefined;
  const timers: number[] = [];
  const next = random(Date.now() >>> 0);
  cancel(bars(wave));
  bars(wave).forEach((bar, index) => bar.animate(
    reduced
      ? [{ opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }]
      : [0.25, 0.5 + next() * 0.5, 0.15 + next() * 0.3, 0.4 + next() * 0.6, 0.25]
        .map((height) => ({ transform: `scaleY(${height.toFixed(2)})` })),
    { duration: 900 + next() * 500, delay: index * 30, iterations: Infinity, easing: 'ease-in-out' },
  ));
  if (reduced) {
    const cells = roots(svg);
    cancel(cells);
    cells.forEach((cell, index) => { cell.style.opacity = String(restingOpacity(index)); });
  } else {
    for (const cell of roots(svg)) cell.style.opacity = String(ROOT_FLOOR);
    const loop = () => { timers.push(window.setTimeout(loop, cycle(svg, next, timers))); };
    loop();
  }
  return () => {
    for (const timer of timers) window.clearTimeout(timer);
    timers.length = 0;
  };
}

function quiet(svg: SVGSVGElement, wave: HTMLElement | null): void {
  for (const cell of svg.querySelectorAll<SVGRectElement>('.startup__sap rect')) {
    const from = getComputedStyle(cell).opacity;
    cancel([cell]);
    cell.animate([{ opacity: from }, { opacity: 0 }], { duration: 220, fill: 'forwards' });
  }
  svg.querySelector('.startup__sparks')?.replaceChildren();
  for (const bar of bars(wave)) {
    cancel([bar]);
    bar.animate([{ transform: 'scaleY(0.6)' }, { transform: 'scaleY(0.12)', opacity: 0.5 }], { duration: 280, fill: 'forwards' });
  }
}

/** Backend ready: roots return to rest, the sap dissolves, the wave goes quiet. */
export function settle(svg: SVGSVGElement, wave: HTMLElement | null): void {
  if (!canAnimate()) return;
  roots(svg).forEach((cell, index) => {
    const from = getComputedStyle(cell).opacity;
    cancel([cell]);
    cell.style.opacity = '';
    cell.animate([{ opacity: from }, { opacity: restingOpacity(index) }], { duration: 260, easing: EASE, fill: 'forwards' });
  });
  quiet(svg, wave);
}

/** Start failed: growth stops and the deepest pixels fall away (the amber comes from CSS). */
export function fail(svg: SVGSVGElement, wave: HTMLElement | null, reduced: boolean): void {
  if (!canAnimate()) return;
  const next = random(3);
  roots(svg).forEach((cell, index) => {
    cancel([cell]);
    cell.style.opacity = String(restingOpacity(index));
    if (reduced || (ROOT_CELLS[index]?.depth ?? 0) <= 0.45 || next() >= 0.7) return;
    cell.animate(
      [{ transform: 'none' }, { transform: `translateY(${60 + next() * 60}px) rotate(${(next() - 0.5) * 60}deg)`, opacity: 0.15 }],
      { duration: 700, delay: 200 + next() * 500, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' },
    );
  });
  quiet(svg, wave);
}

/** The empty transcript's tree, once it is laid out and nothing covers it (onboarding, a drawer). */
function findTarget(timeoutMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const look = () => {
      const target = document.querySelector('[data-tree-target]');
      const box = target?.getBoundingClientRect();
      if (target && box && box.width > 0 && box.height > 0) {
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (hit && target.contains(hit)) { resolve(target); return; }
      }
      if (performance.now() - started > timeoutMs) { resolve(null); return; }
      requestAnimationFrame(look);
    };
    look();
  });
}

const fadeOut = (element: Element | null, duration: number): Animation | undefined =>
  element?.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'ease', fill: 'forwards' });

/**
 * Called once the screen stopped taking input: the workspace is revealed at
 * once, and the tree moves onto the empty transcript if one is visible,
 * otherwise it dissolves in place. Nothing in the app waits for this.
 */
export async function handOff(gate: HTMLElement, svg: SVGSVGElement, reduced: boolean): Promise<void> {
  if (!canAnimate()) return;
  fadeOut(gate.querySelector('.startup__backdrop'), reduced ? 120 : 360);
  fadeOut(gate.querySelector('.startup__wave'), 160);
  const target = reduced ? null : await findTarget(300);
  if (!target) {
    await fadeOut(svg, reduced ? 120 : 260)?.finished.catch(() => undefined);
    return;
  }
  const from = svg.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  target.setAttribute('data-tree-arriving', '');
  try {
    await svg.animate(
      [{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${to.height / from.height})` }],
      { duration: 520, easing: EASE, fill: 'forwards' },
    ).finished;
  } catch {
    // Cancelled: the screen is leaving anyway.
  } finally {
    target.removeAttribute('data-tree-arriving');
  }
}
