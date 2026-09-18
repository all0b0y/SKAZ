// A small rehype-compatible plugin (no extra dependency — unified plugins are
// just functions) that records, on every rendered block, where it came from in
// the Markdown source.
//
// Notes are shown rendered but rewritten by source offsets, and the two differ
// wherever markup was consumed. The parser already knows the mapping: every node
// carries the source range it was built from. Keeping that range on the element
// is what lets a selection made on screen be named as a span of the stored file
// instead of being guessed at by searching the whole document for its text.
//
// Only block-level elements are annotated. An inline one would multiply the
// attributes for no gain: the block is already narrow enough to disambiguate a
// repeated phrase, and the exact span is found inside it by text.

import type { HastNode } from './citationHighlight';

interface Positioned {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Positioned[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

const BLOCK_TAGS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'td', 'th',
]);

function annotate(node: Positioned): void {
  if (node.type === 'element' && node.tagName && BLOCK_TAGS.has(node.tagName)) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      node.properties = { ...node.properties, dataMdStart: String(start), dataMdEnd: String(end) };
    }
  }
  for (const child of node.children ?? []) annotate(child);
}

/** Unified/rehype plugin: `rehypePlugins={[markSourceOffsets]}`. */
export function markSourceOffsets() {
  return (tree: HastNode) => {
    annotate(tree as Positioned);
  };
}
