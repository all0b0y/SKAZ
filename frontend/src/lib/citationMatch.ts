// Matches a piece of selected notes text back to the transcript citation it
// most likely came from. Pure function, no React: the notes UI decides what
// to render, this module only decides whether a match is trustworthy enough
// to show a "jump to transcript" affordance.
//
// Strategy, in order of confidence:
//   1. Exact substring — the selection appears verbatim inside a citation.
//   2. Reverse substring — the citation text appears verbatim inside the
//      selection (the user selected a wider span that contains the quote).
//   3. Normalized word overlap — after lowercasing, stripping punctuation and
//      collapsing whitespace, most of the shorter text's words are present in
//      the longer one. The threshold is intentionally strict: a wrong jump
//      target is worse than no jump target at all, so ambiguous or thin
//      overlaps are reported as "not found" rather than guessed.

export interface CitationLike {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

export type CitationMatchStrategy = 'exact-substring' | 'reverse-substring' | 'normalized-words';

export interface CitationMatchResult<T extends CitationLike = CitationLike> {
  citation: T;
  strategy: CitationMatchStrategy;
}

/** Strict overlap threshold: the smaller text's words must be almost entirely
 * present in the other, not just loosely related. */
const WORD_OVERLAP_THRESHOLD = 0.75;
/** Below this word count, normalized matching is too easy to fool by chance
 * (e.g. a single common word); refuse to guess. */
const MIN_WORDS_FOR_NORMALIZED_MATCH = 3;

const normalizeWords = (text: string): string[] => (
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
);

const overlapRatio = (a: readonly string[], b: readonly string[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  const shared = a.filter((word) => bSet.has(word)).length;
  return shared / Math.min(a.length, b.length);
};

/**
 * Find the best citation match for a selection, or null if nothing is
 * confident enough. `citations` is searched in order; the first exact or
 * reverse match wins, otherwise the highest-scoring normalized match above
 * the threshold wins.
 */
export function matchCitation<T extends CitationLike>(
  selectedText: string,
  citations: readonly T[],
): CitationMatchResult<T> | null {
  const selected = selectedText.trim();
  if (!selected || citations.length === 0) return null;

  for (const citation of citations) {
    if (citation.text.trim().length > 0 && citation.text.includes(selected)) {
      return { citation, strategy: 'exact-substring' };
    }
  }

  for (const citation of citations) {
    const citationText = citation.text.trim();
    if (citationText.length > 0 && selected.includes(citationText)) {
      return { citation, strategy: 'reverse-substring' };
    }
  }

  const selectedWords = normalizeWords(selected);
  if (selectedWords.length < MIN_WORDS_FOR_NORMALIZED_MATCH) return null;

  let best: { citation: T; score: number } | null = null;
  for (const citation of citations) {
    const citationWords = normalizeWords(citation.text);
    if (citationWords.length < MIN_WORDS_FOR_NORMALIZED_MATCH) continue;
    const score = overlapRatio(selectedWords, citationWords);
    if (score >= WORD_OVERLAP_THRESHOLD && (!best || score > best.score)) {
      best = { citation, score };
    }
  }
  return best ? { citation: best.citation, strategy: 'normalized-words' } : null;
}

/** Convenience wrapper for callers that only need the matched citation. */
export function findCitationForSelection<T extends CitationLike>(
  selectedText: string,
  citations: readonly T[],
): T | null {
  return matchCitation(selectedText, citations)?.citation ?? null;
}
