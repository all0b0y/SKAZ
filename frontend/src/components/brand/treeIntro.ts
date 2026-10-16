import { ROOT_CELLS, SAP } from '../../brand/treeGeometry';
import { cancelAnimations } from '../../lib/webAnimations';

/**
 * The tree's intro in the empty transcript: pixels rise out of the ground into
 * the roots, then sap climbs the trunk and spreads through the crown as sparks.
 * It plays once per app run (the caller then shows the SKAZ wordmark); every
 * later empty transcript shows the still tree.
 */

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ROOT_STAGGER_MS = 7;
const TRUNK_STEP_MS = 55;
const BRANCH_STEP_MS = 34;

let played = false;

/** Whether this app run still has its intro to play. */
export const treeIntroPending = (): boolean => !played;

/** Claims the run's only intro; false when another empty transcript already has it. */
export function claimTreeIntro(): boolean {
  if (played) return false;
  played = true;
  return true;
}

/** Test seam: start a new app run. */
export function resetTreeIntro(): void {
  played = false;
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
  const layer = svg.querySelector('.tree-intro__sparks');
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

/**
 * Plays the intro on a TreeMark that renders the `.tree-intro__sap` and
 * `.tree-intro__sparks` layers; calls onDone once the sap has faded.
 * Returns a stop function that leaves the tree still.
 */
export function playTreeIntro(svg: SVGSVGElement, onDone: () => void): () => void {
  const timers: number[] = [];
  const next = random(Date.now() >>> 0);
  const roots = Array.from(svg.querySelectorAll<SVGRectElement>('.tree-mark__roots rect'));
  const trunk = Array.from(svg.querySelectorAll<SVGRectElement>('.tree-intro__sap [data-part="trunk"]'));
  const branch = Array.from(svg.querySelectorAll<SVGRectElement>('.tree-intro__sap [data-part="branch"]'));

  // Deepest pixels first, rising into place: the roots grow up out of the ground.
  const jitter = roots.map(() => next());
  const order = roots.map((_, index) => index)
    .sort((a, b) => (ROOT_CELLS[b]?.y ?? 0) - (ROOT_CELLS[a]?.y ?? 0) || (jitter[a] ?? 0) - (jitter[b] ?? 0));
  order.forEach((index, n) => roots[index]?.animate(
    [{ opacity: 0, transform: 'translateY(110px)' }, { opacity: ROOT_CELLS[index]?.opacity ?? 1, transform: 'none' }],
    { duration: 420, delay: n * ROOT_STAGGER_MS, easing: EASE, fill: 'backwards' },
  ));

  const trunkStart = order.length * ROOT_STAGGER_MS + 260;
  trunk.forEach((cell, n) => cell.animate(
    [{ opacity: 0, transform: 'scale(0.3)' }, { opacity: 1, transform: 'none' }],
    { duration: 220, delay: trunkStart + n * TRUNK_STEP_MS, easing: EASE, fill: 'forwards' },
  ));
  const branchStart = trunkStart + SAP.trunk.length * TRUNK_STEP_MS;
  branch.forEach((cell, n) => cell.animate(
    [{ opacity: 0, transform: 'scale(0.2)' }, { opacity: 0.95, transform: 'none' }],
    {
      duration: 240, easing: EASE, fill: 'forwards',
      delay: branchStart + ((SAP.branches[n]?.step ?? 0) - SAP.trunk.length) * BRANCH_STEP_MS,
    },
  ));

  const lastStep = Math.max(0, ...SAP.branches.map((cell) => cell.step)) - SAP.trunk.length;
  const sparksAt = branchStart + lastStep * BRANCH_STEP_MS + 120;
  const fadeAt = sparksAt + 700;
  timers.push(window.setTimeout(() => sparks(svg, next), sparksAt));
  timers.push(window.setTimeout(() => {
    for (const cell of [...trunk, ...branch]) {
      cell.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 520, easing: 'ease', fill: 'forwards' });
    }
  }, fadeAt));
  timers.push(window.setTimeout(onDone, fadeAt + 540));
  return () => {
    for (const timer of timers) window.clearTimeout(timer);
    cancelAnimations([...roots, ...trunk, ...branch]);
  };
}
