/**
 * P2: what the user picked in one answer — items of an answer block or nodes/edges of a Mermaid
 * diagram — addressed by ids, never by position or SVG internals. Spec:
 * `.dev/docs/backlog-2026-10-26/P2-DRAW-ON-DIAGRAMS.md` (decisions 1–4), look: answer-blocks-v3.html.
 *
 * The selection lives in one answer and one block at a time: picking in another block starts over.
 */

/** One picked item: its id in the block (or diagram) and a short label the user saw. */
export interface SelectedItem {
  id: string;
  label: string;
}

/** Where the items are: an answer message, and a block of it (an answer block or a diagram). */
export interface SelectionTarget {
  message_id: string;
  block_id: string;
  /** `study` (P3-c): a test question — `block_id` is the test block, the one item its question. */
  kind: 'block' | 'diagram' | 'study';
  /** The block's own title, if it has one (shown in the chip). */
  title: string | null;
}

export interface Selection extends SelectionTarget {
  items: SelectedItem[];
}

/** At most this many items go with one question (the backend checks the same). */
export const MAX_SELECTED = 20;
export const LABEL_CHARS = 80;

export function clip(text: string, chars = LABEL_CHARS): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > chars ? `${one.slice(0, chars - 1).trimEnd()}…` : one;
}

export function sameTarget(a: SelectionTarget, b: SelectionTarget): boolean {
  return a.message_id === b.message_id && a.block_id === b.block_id;
}

/** «“Timeout”» for one item, «3 items» for more. */
export function itemsLabel(items: readonly SelectedItem[]): string {
  if (items.length === 1) return `“${clip(items[0]!.label, 48)}”`;
  return `${items.length} items`;
}

/** The chip on the question: «“Timeout” · Leader election», «3 items · Diagram». */
export function chipLabel(selection: Pick<Selection, 'items' | 'title' | 'kind'>): string {
  // P3-c: «📍 question 3 · Lecture 8 check».
  if (selection.kind === 'study') return [selection.items[0]?.label ?? 'question', selection.title].filter(Boolean).join(' · ');
  const where = selection.title ? clip(selection.title, 48) : selection.kind === 'diagram' ? 'Diagram' : null;
  return where ? `${itemsLabel(selection.items)} · ${where}` : itemsLabel(selection.items);
}

/**
 * The id of a diagram in an answer: FNV-1a (32 bit) over the UTF-8 of its Mermaid text with each
 * line trimmed and empty lines dropped. The backend (`chats/selection.py`) computes the same, so it
 * can find the diagram in the stored answer without trusting the client.
 */
export function diagramId(source: string): string {
  const normal = source.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(normal)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `mmd-${hash.toString(16).padStart(8, '0')}`;
}
