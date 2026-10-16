import type { KbCitation } from '../../api/kb/types.gen';

/**
 * Footnote numbers for sources (v42, variant A): one number per source document within one answer
 * or one wiki page, in the order the documents first appear; the same document keeps its number.
 * Quotes are merged when they are the same material + fragment + words.
 */
export interface SourceEntry {
  /** The material id: one number per document. */
  key: string;
  n: number;
  title: string;
  recording: boolean;
  /** False once the material is gone (every citation of it says so). */
  available: boolean;
  /** Distinct quotes of this document in the whole answer/page, in order. */
  quotes: KbCitation[];
}

export interface SourceIndex {
  list: SourceEntry[];
  byKey: Map<string, SourceEntry>;
}

/** One number of a claim: the document and only the quotes this claim cites. */
export interface ClaimSource {
  entry: SourceEntry;
  quotes: KbCitation[];
}

export const quoteKey = (c: KbCitation): string => `${c.material_id}\u0000${c.seg}\u0000${c.quote ?? ''}`;

/** Distinct citations in order (same material + fragment + quote shown once). */
export function distinct(citations: Iterable<KbCitation>): KbCitation[] {
  const seen = new Set<string>();
  const out: KbCitation[] = [];
  for (const c of citations) {
    const key = quoteKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function indexSources(citations: Iterable<KbCitation>): SourceIndex {
  const list: SourceEntry[] = [];
  const byKey = new Map<string, SourceEntry>();
  for (const c of distinct(citations)) {
    let entry = byKey.get(c.material_id);
    if (!entry) {
      entry = {
        key: c.material_id, n: list.length + 1, title: c.material_title ?? 'Source',
        recording: c.start_ms !== null, available: c.available, quotes: [],
      };
      byKey.set(c.material_id, entry);
      list.push(entry);
    }
    if (entry.title === 'Source' && c.material_title) entry.title = c.material_title;
    entry.available = entry.available && c.available;
    entry.quotes.push(c);
  }
  return { list, byKey };
}

/**
 * The numbers one claim shows: one per document, in the claim's order, its own quotes merged.
 * A document missing from `index` (no surrounding answer/page) is numbered after the known ones.
 */
export function claimSources(citations: ReadonlyArray<KbCitation>, index: SourceIndex): ClaimSource[] {
  const own = indexSources(citations);
  let extra = index.list.length;
  return own.list.map((mine) => {
    const entry = index.byKey.get(mine.key) ?? { ...mine, n: (extra += 1) };
    return { entry, quotes: mine.quotes };
  });
}
