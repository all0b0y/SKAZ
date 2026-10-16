// Text helpers of the document panel: what a wiki block shows, and where a checked quote sits
// inside a fragment. Untrusted text stays text — nothing here produces markup.

import type { KbBlockLink } from '../../api/kb/types.gen';

/** `[[target#anchor|label]]`: target, optional anchor, optional label. */
const WIKILINK = /(\s*)\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;
const BLOCK_ANCHOR = /\s+\^c-[A-Za-z0-9-]+\s*$/;
/** URL schemes of the in-app links `blockMarkdown` writes (AnswerMarkdown hands them to `onLink`). */
export const PAGE_HREF = 'skaz-page:';
export const MATERIAL_HREF = 'skaz-material:';

const isCitation = (target: string, anchor: string | undefined) => target.startsWith('Materials/') && !!anchor?.startsWith('#^seg-');
const labelOf = (target: string, label: string | undefined) => (label ?? target.split('/').pop() ?? target).trim();

/**
 * Block text for reading and editing: citation wikilinks into materials are removed (the
 * citations are shown as footnotes next to the block), other wikilinks are reduced to what the
 * reader sees. The backend puts the links back when the edited text is saved (QA C4).
 */
export function readableBlockText(text: string): string {
  return text
    .replace(WIKILINK, (_all: string, space: string, target: string, anchor: string | undefined, label: string | undefined) =>
      (isCitation(target.trim(), anchor) ? '' : `${space}${labelOf(target, label)}`))
    .replace(BLOCK_ANCHOR, '')
    .trim();
}

const escapeLabel = (label: string) => label.replace(/[\\[\]]/g, '\\$&');

/**
 * Block text as Markdown for the page (QA C1/C2): a wikilink to another page or to a material
 * becomes a link the reader can follow (`skaz-page:<id>` / `skaz-material:<id>`), a link to
 * nothing reads as its label, citation links are left out. An agent's navigation list that
 * starts with "1." stays text, not a Markdown list that would eat the number (QA C11).
 */
export function blockMarkdown(text: string, links: KbBlockLink[] | undefined, agentText = false): string {
  const byTarget = new Map((links ?? []).map((l) => [l.target, l]));
  const body = text
    .replace(WIKILINK, (_all: string, space: string, rawTarget: string, anchor: string | undefined, label: string | undefined) => {
      const target = rawTarget.trim();
      if (isCitation(target, anchor)) return '';
      const shown = labelOf(target, label);
      const link = byTarget.get(target);
      if (link?.page) return `${space}[${escapeLabel(shown)}](${PAGE_HREF}${encodeURIComponent(link.page.id)})`;
      if (link?.material_id) return `${space}[${escapeLabel(shown)}](${MATERIAL_HREF}${encodeURIComponent(link.material_id)})`;
      return `${space}${shown}`;
    })
    .replace(BLOCK_ANCHOR, '')
    .trim();
  return agentText ? body.replace(/^(\d+)\.(\s)/, '$1\\.$2') : body;
}

/** The in-app target of a `blockMarkdown` link, or null for anything else. */
export function inAppTarget(href: string): { type: 'page' | 'material'; id: string } | null {
  if (href.startsWith(PAGE_HREF)) return { type: 'page', id: decodeURIComponent(href.slice(PAGE_HREF.length)) };
  if (href.startsWith(MATERIAL_HREF)) return { type: 'material', id: decodeURIComponent(href.slice(MATERIAL_HREF.length)) };
  return null;
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
