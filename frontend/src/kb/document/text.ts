// Text helpers of the document panel: what a wiki block shows, and where a checked quote sits
// inside a fragment. Untrusted text stays text — nothing here produces markup.

const MATERIAL_LINK = /\s*\[\[Materials\/[^\]\n]*\]\]/g;
const LABELLED_LINK = /\[\[[^\]|\n]+\|([^\]\n]+)\]\]/g;
const BARE_LINK = /\[\[([^\]|\n#]+)(?:#[^\]|\n]*)?\]\]/g;
const BLOCK_ANCHOR = /\s+\^c-[A-Za-z0-9-]+\s*$/;

/**
 * Block text for reading: citation wikilinks into materials are removed (the citations are
 * shown as chips next to the block), other wikilinks are reduced to what the reader sees.
 */
export function readableBlockText(text: string): string {
  return text
    .replace(MATERIAL_LINK, '')
    .replace(LABELLED_LINK, '$1')
    .replace(BARE_LINK, (_, target: string) => target.split('/').pop() ?? target)
    .replace(BLOCK_ANCHOR, '')
    .trim();
}

export interface TextPart {
  text: string;
  mark: boolean;
}

const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase();

/**
 * Split `text` around the first occurrence of `quote` (case-insensitive, whitespace-tolerant).
 * No match → one unmarked part: the fragment is still shown, the quote just isn't marked.
 */
export function markQuote(text: string, quote: string | null | undefined): TextPart[] {
  const q = quote?.trim();
  if (!q) return [{ text, mark: false }];
  const hay = fold(text);
  const needle = fold(q);
  let at = hay.indexOf(needle);
  let length = needle.length;
  if (at < 0) {
    // Whitespace may differ (line breaks, double spaces): match words separated by any spaces.
    const words = needle.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return [{ text, mark: false }];
    const found = new RegExp(words.join('\\s+'), 'u').exec(hay);
    if (!found) return [{ text, mark: false }];
    at = found.index;
    length = found[0].length;
  }
  const parts: TextPart[] = [];
  if (at > 0) parts.push({ text: text.slice(0, at), mark: false });
  parts.push({ text: text.slice(at, at + length), mark: true });
  if (at + length < text.length) parts.push({ text: text.slice(at + length), mark: false });
  return parts;
}

/** "Updated 2 h ago" style relative time, honest and coarse. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.round((now - t) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
