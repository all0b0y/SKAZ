import type { KbCorrection, KbFragment, KbTranslation } from '../../api/kb/types.gen';
import { markQuote } from '../document/text';

export interface TextPiece {
  text: string;
  /** Part of the checked quote the user came for. */
  quote: boolean;
  /** Recognition fix shown here (dotted underline, click → popover). */
  fix: KbCorrection | null;
}

/** The words a correction occupies in the fragment text as shown now. */
export function fixTarget(c: KbCorrection): string | null {
  if (c.state === 'applied') return c.after;
  if (c.state === 'doubtful' || c.state === 'reverted') return c.before;
  return null;
}

/**
 * Split a fragment into pieces: the quote range (if any) and each correction's words
 * (first free, non-overlapping occurrence). Untouched text stays as plain pieces.
 */
export function segmentText(text: string, quote: string | null | undefined, fixes: readonly KbCorrection[]): TextPiece[] {
  type Range = { start: number; end: number };
  let quoteRange: Range | null = null;
  if (quote) {
    let at = 0;
    for (const part of markQuote(text, quote)) {
      if (part.mark) { quoteRange = { start: at, end: at + part.text.length }; break; }
      at += part.text.length;
    }
  }
  const fixRanges: Array<Range & { fix: KbCorrection }> = [];
  for (const fix of fixes) {
    const target = fixTarget(fix);
    if (!target) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(target, from);
      if (at < 0) break;
      const end = at + target.length;
      if (!fixRanges.some((r) => at < r.end && end > r.start)) { fixRanges.push({ start: at, end, fix }); break; }
      from = at + 1;
    }
  }
  const cuts = new Set<number>([0, text.length]);
  if (quoteRange) { cuts.add(quoteRange.start); cuts.add(quoteRange.end); }
  for (const r of fixRanges) { cuts.add(r.start); cuts.add(r.end); }
  const points = [...cuts].sort((a, b) => a - b);
  const pieces: TextPiece[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;
    const inQuote = quoteRange !== null && start >= quoteRange.start && end <= quoteRange.end;
    const fix = fixRanges.find((r) => start >= r.start && end <= r.end)?.fix ?? null;
    const last = pieces[pieces.length - 1];
    if (last && last.quote === inQuote && last.fix === fix) last.text += text.slice(start, end);
    else pieces.push({ text: text.slice(start, end), quote: inQuote, fix });
  }
  return pieces.length ? pieces : [{ text, quote: false, fix: null }];
}

export interface Monologue {
  key: string;
  speaker: string | null;
  startMs: number | null;
  fragments: KbFragment[];
}

/** Consecutive fragments of one speaker form one monologue "Speaker N · 08:12". */
export function monologues(fragments: readonly KbFragment[]): Monologue[] {
  const out: Monologue[] = [];
  for (const f of fragments) {
    const last = out[out.length - 1];
    if (last && last.speaker === f.speaker && f.speaker !== null) { last.fragments.push(f); continue; }
    out.push({ key: f.id, speaker: f.speaker, startMs: f.start_ms, fragments: [f] });
  }
  return out;
}

export interface PdfPage {
  page: number | null;
  fragments: KbFragment[];
}

export function byPage(fragments: readonly KbFragment[]): PdfPage[] {
  const out: PdfPage[] = [];
  for (const f of fragments) {
    const last = out[out.length - 1];
    if (last && last.page === f.page) last.fragments.push(f);
    else out.push({ page: f.page, fragments: [f] });
  }
  return out;
}

/** Translation by fragment when it has segment ids; null = paragraphs in order (Soniox). */
export function translationBySeg(translation: KbTranslation | null): Map<number, string> | null {
  if (!translation || translation.fragments.length === 0) return null;
  if (translation.fragments.some((f) => f.seg === null)) return null;
  const map = new Map<number, string>();
  for (const f of translation.fragments) map.set(f.seg!, map.has(f.seg!) ? `${map.get(f.seg!)} ${f.text}` : f.text);
  return map;
}

/** Speaker colour: folder slot by speaker number, so speakers are told apart by name and colour. */
export function speakerTone(speaker: string | null): string {
  const n = Number(/(\d+)/.exec(speaker ?? '')?.[1] ?? '1');
  return `var(--kb-folder-${((Math.max(1, n) - 1) % 4) + 1})`;
}
