// A small rehype-compatible plugin (no extra dependency — unified plugins are
// just functions, and remark-gfm is already the one markdown dependency this
// redesign added) that marks up cited passages in rendered notes before the
// reader even selects anything.
//
// Deliberately conservative, per the "don't break markdown for a dotted
// underline" constraint:
//   - Only whole-substring matches (a citation's text found inside a text
//     leaf, or a short text leaf found inside a citation's text) are marked.
//     The fuzzy normalized-word strategy from citationMatch.ts has no exact
//     span to underline, so it is not used here.
//   - Only plain text leaves are split; matches never cross node boundaries,
//     so emphasis/links/existing structure are never touched.
//   - `code`, `pre`, and `a` subtrees are left untouched entirely, so inline
//     code and link text are never rewritten.

import type { CitationLike } from './citationMatch';

interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

export type HastNode =
  | HastText
  | HastElement
  | { type: string; children?: HastNode[]; value?: string };

const SKIP_TAGS = new Set(['code', 'pre', 'a']);
/** Below this, a "match" is too generic to trust as a real citation span. */
const MIN_QUOTE_LENGTH = 12;

function isHastText(node: HastNode): node is HastText {
  return node.type === 'text' && typeof (node as HastText).value === 'string';
}

function hasChildren(node: HastNode): node is HastElement | { type: string; children: HastNode[] } {
  return Array.isArray((node as { children?: HastNode[] }).children);
}

function findQuoteSpan(
  text: string,
  citations: readonly CitationLike[],
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  const trimmed = text.trim();
  for (const citation of citations) {
    const quote = citation.text.trim();
    if (quote.length >= MIN_QUOTE_LENGTH) {
      const index = text.indexOf(quote);
      if (index >= 0 && (!best || quote.length > best.end - best.start)) {
        best = { start: index, end: index + quote.length };
      }
    }
    if (trimmed.length >= MIN_QUOTE_LENGTH && quote.includes(trimmed)) {
      const start = text.indexOf(trimmed);
      if (start >= 0 && (!best || trimmed.length > best.end - best.start)) {
        best = { start, end: start + trimmed.length };
      }
    }
  }
  return best;
}

function splitTextNode(node: HastText, citations: readonly CitationLike[]): HastNode[] {
  const span = findQuoteSpan(node.value, citations);
  if (!span) return [node];
  const before = node.value.slice(0, span.start);
  const matched = node.value.slice(span.start, span.end);
  const after = node.value.slice(span.end);
  const parts: HastNode[] = [];
  if (before) parts.push({ type: 'text', value: before });
  parts.push({
    type: 'element',
    tagName: 'mark',
    properties: { className: ['notes__cited'] },
    children: [{ type: 'text', value: matched }],
  });
  if (after) parts.push({ type: 'text', value: after });
  return parts;
}

function walk(node: HastNode, citations: readonly CitationLike[]): void {
  if (!hasChildren(node)) return;
  if (node.type === 'element' && SKIP_TAGS.has((node as HastElement).tagName)) return;
  const nextChildren: HastNode[] = [];
  for (const child of node.children) {
    if (isHastText(child)) {
      nextChildren.push(...splitTextNode(child, citations));
    } else {
      walk(child, citations);
      nextChildren.push(child);
    }
  }
  node.children = nextChildren;
}

/** Unified/rehype plugin factory: `rehypePlugins={[[highlightCitedText, citations]]}`. */
export function highlightCitedText(citations: readonly CitationLike[]) {
  return (tree: HastNode) => {
    walk(tree, citations);
  };
}
