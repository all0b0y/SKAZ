import type { ChatFindResult, ChatMatch, ChatMatchRange, RenderedChatRun } from './findMatches';

export interface RenderedChatTextRun extends RenderedChatRun {
  readonly node: Text;
  readonly svgLabel: Element | null;
}

const MESSAGE = ':is(.kb-msg--user, .kb-msg--assistant)[data-message-id]';
const SKIP = 'script, style, template, textarea, .kb-visually-hidden, .katex-mathml, [hidden]';
const SVG = 'http://www.w3.org/2000/svg';
const SVG_METADATA = new Set(['title', 'desc', 'defs', 'clipPath', 'mask', 'symbol']);

/** Read message content in DOM order, including offscreen history and drawn diagram labels. */
export function collectRenderedChatRuns(scroll: HTMLElement): RenderedChatTextRun[] {
  const view = scroll.ownerDocument.defaultView;
  if (!view) return [];
  const runs: RenderedChatTextRun[] = [];
  for (const message of scroll.querySelectorAll<HTMLElement>(MESSAGE)) {
    const body = message.querySelector<HTMLElement>(':scope > :is(.kb-msg__bubble, .kb-msg__body)');
    if (!body || message.closest('[hidden]') || view.getComputedStyle(message).display === 'none') continue;
    const messageId = message.dataset.messageId!;
    let breakBefore = true;
    const walk = (node: Node, svgLabel: Element | null = null) => {
      if (node instanceof view.Text) {
        if (!node.data || (breakBefore && !node.data.trim())) return;
        if (node.parentElement?.namespaceURI === SVG && !svgLabel) return;
        runs.push({ messageId, text: node.data, node, svgLabel, breakBefore });
        breakBefore = false;
      } else if (node instanceof view.Element) {
        const tag = node.localName;
        const svg = node.namespaceURI === SVG;
        if (node.matches(SKIP) || (svg && SVG_METADATA.has(tag))) return;
        const style = view.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || style.contentVisibility === 'hidden') return;
        const block = svg ? tag === 'text' : tag === 'br'
          || (style.display !== '' && !style.display.startsWith('inline') && style.display !== 'contents');
        if (block) breakBefore = true;
        const label = svg && tag === 'text' ? node : svgLabel;
        if (node instanceof view.HTMLDetailsElement && !node.open) {
          const summary = node.querySelector(':scope > summary');
          if (summary) walk(summary, label);
        } else {
          for (const child of node.childNodes) walk(child, label);
        }
        if (block) breakBefore = true;
      }
    };
    walk(body);
  }
  return runs;
}

function toRange(runs: readonly RenderedChatTextRun[], { runIndex, start, end }: ChatMatchRange): Range | null {
  const run = runs[runIndex];
  if (!run || !run.node.isConnected || end > run.node.length) return null;
  const range = run.node.ownerDocument.createRange();
  range.setStart(run.node, start);
  range.setEnd(run.node, end);
  return range;
}

const MATCH = 'kb-chat-find-match';
const ACTIVE = 'kb-chat-find-active';
const DIAGRAM_HIT = 'data-kb-chat-find-label';

/** Paint DOM ranges without wrapping or splitting text nodes owned by React. */
export function createChatHighlights(doc: Document) {
  const view = doc.defaultView;
  const registry = view?.CSS?.highlights;
  let labels = new Map<Element, 'match' | 'active'>();
  const clear = () => {
    registry?.delete(MATCH);
    registry?.delete(ACTIVE);
    for (const label of labels.keys()) label.removeAttribute(DIAGRAM_HIT);
    labels.clear();
  };
  const paint = (runs: readonly RenderedChatTextRun[], result: ChatFindResult) => {
    const all = view?.Highlight && new view.Highlight();
    const current = view?.Highlight && new view.Highlight();
    const nextLabels = new Map<Element, 'match' | 'active'>();
    for (const match of result.matches) {
      const active = match.id === result.activeMatch?.id;
      for (const part of match.ranges) {
        const label = runs[part.runIndex]?.svgLabel;
        if (label) {
          // A drawn SVG label gets its own paint treatment through CSS.
          if (active || !nextLabels.has(label)) nextLabels.set(label, active ? 'active' : 'match');
        } else {
          const range = toRange(runs, part);
          if (range) (active ? current : all)?.add(range);
        }
      }
    }
    if (all?.size) registry?.set(MATCH, all);
    else registry?.delete(MATCH);
    if (current?.size) registry?.set(ACTIVE, current);
    else registry?.delete(ACTIVE);
    for (const label of labels.keys()) if (!nextLabels.has(label)) label.removeAttribute(DIAGRAM_HIT);
    for (const [label, state] of nextLabels) if (labels.get(label) !== state) label.setAttribute(DIAGRAM_HIT, state);
    labels = nextLabels;
  };
  return { paint, clear };
}

function centerIfClipped(start: number, end: number, viewportStart: number, size: number) {
  if (start >= viewportStart && end <= viewportStart + size) return 0;
  return start - viewportStart + (Math.min(end - start, size) - size) / 2;
}

function clipsOverflow(value: string) {
  return value === 'auto' || value === 'scroll' || value === 'hidden';
}

/** Reveal the first line of the active range, scrolling only within this conversation. */
export function revealChatMatch(
  scroll: HTMLElement,
  runs: readonly RenderedChatTextRun[],
  match: ChatMatch,
  behavior: ScrollBehavior,
  beforeScroll: (element: HTMLElement) => void,
) {
  const part = match.ranges[0];
  const run = part && runs[part.runIndex];
  const view = scroll.ownerDocument.defaultView;
  if (!part || !view || !run || !scroll.contains(run.node)) return;
  const range = toRange(runs, part);
  const origin = run.svgLabel ?? run.node.parentElement;
  const bounds = () => Array.from(range?.getClientRects?.() ?? []).find((box) => box.width > 0 && box.height > 0)
    ?? origin?.getBoundingClientRect();
  for (let ancestor = origin; ancestor; ancestor = ancestor.parentElement) {
    const main = ancestor === scroll;
    if (ancestor instanceof view.HTMLElement) {
      const style = view.getComputedStyle(ancestor);
      const x = ancestor.scrollWidth > ancestor.clientWidth && (main || clipsOverflow(style.overflowX));
      const y = ancestor.scrollHeight > ancestor.clientHeight && (main || clipsOverflow(style.overflowY));
      if (x || y) {
        const hit = bounds();
        if (!hit) return;
        const viewport = ancestor.getBoundingClientRect();
        const dx = x ? centerIfClipped(hit.left, hit.right, viewport.left + ancestor.clientLeft, ancestor.clientWidth) : 0;
        const dy = y ? centerIfClipped(hit.top, hit.bottom, viewport.top + ancestor.clientTop, ancestor.clientHeight) : 0;
        if (dx || dy) {
          beforeScroll(ancestor);
          ancestor.scrollTo({ left: ancestor.scrollLeft + dx, top: ancestor.scrollTop + dy, behavior: main ? behavior : 'instant' });
        }
      }
    }
    if (main) break;
  }
}
