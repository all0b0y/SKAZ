import type { Citation } from '../api/types';

/**
 * Turns an assistant answer's inline citation labels (`[P2–P5, P9]`) into
 * numbered footnotes.
 *
 * The backend records on each citation the labels that resolved to it
 * (`Citation.labels`). Only that record ties a place in the text to a source;
 * nothing here matches by order or by text. Answers saved before the record
 * existed have no labels at all: their inline marks are removed and their
 * sources stay a separate list (`legacy`).
 */

/** Same shape the backend's LABEL_PATTERN accepts. */
const LABEL_BLOCK = /\[\s*[SP]\d{1,4}(?:\s*[-–—,]\s*[SP]?\d{1,4})*\s*\]/g;
const DASH = /[-–—]/;
/** Private-use code points: never produced by the model, safe as placeholders. */
export const MARK_OPEN = '\uE000';
export const MARK_CLOSE = '\uE001';

export interface Footnote {
  /** 1-based number shown in the text. */
  n: number;
  /** Sources this footnote names, in transcript-label order. */
  citations: Citation[];
}

export interface AnswerFootnotes {
  /** Answer text with each footnote as MARK_OPEN + n + MARK_CLOSE. */
  text: string;
  footnotes: Footnote[];
  /** Sources of an answer saved without label records, shown as a list. */
  legacy: Citation[];
}

/** Label keys one part of a block names, e.g. `P2-5` → P2 P3 P4 P5. */
function partKeys(part: string, previous: string): { keys: string[]; prefix: string } | null {
  const numbers = [...part.matchAll(/\d{1,4}/g)].map((m) => Number(m[0]));
  const letters = new Set(part.toUpperCase().match(/[SP]/g) ?? []);
  if (!numbers.length || letters.size > 1) return null;
  const prefix = [...letters][0] ?? previous;
  if (numbers.length >= 2 && DASH.test(part)) {
    const [first, last] = [Math.min(numbers[0]!, numbers.at(-1)!), Math.max(numbers[0]!, numbers.at(-1)!)];
    return { keys: Array.from({ length: last - first + 1 }, (_, i) => `${prefix}${first + i}`), prefix };
  }
  return { keys: numbers.map((n) => `${prefix}${n}`), prefix };
}

export function answerFootnotes(content: string, citations: readonly Citation[] = []): AnswerFootnotes {
  const byLabel = new Map<string, number[]>();
  citations.forEach((citation, index) => {
    for (const label of citation.labels ?? []) {
      byLabel.set(label, [...(byLabel.get(label) ?? []), index]);
    }
  });
  if (!byLabel.size) {
    return { text: tidy(content.replace(LABEL_BLOCK, '')), footnotes: [], legacy: [...citations] };
  }
  const footnotes: Footnote[] = [];
  const numberOf = new Map<string, number>();
  const text = content.replace(LABEL_BLOCK, (block) => {
    let prefix = 'S';
    const marks: number[] = [];
    for (const part of block.slice(1, -1).split(',')) {
      const parsed = partKeys(part, prefix);
      if (!parsed) continue;
      prefix = parsed.prefix;
      const indexes = [...new Set(parsed.keys.flatMap((key) => byLabel.get(key) ?? []))].sort((a, b) => a - b);
      if (!indexes.length) continue;
      const identity = indexes.join(',');
      let n = numberOf.get(identity);
      if (n === undefined) {
        n = footnotes.length + 1;
        numberOf.set(identity, n);
        footnotes.push({ n, citations: indexes.map((i) => citations[i]!) });
      }
      if (!marks.includes(n)) marks.push(n);
    }
    return marks.map((n) => `${MARK_OPEN}${n}${MARK_CLOSE}`).join('');
  });
  return { text: tidy(text), footnotes, legacy: [] };
}

/** A removed or moved label leaves `word .` / `word  more`: close those gaps, and
 * attach a footnote mark to the word it follows, as a superscript would be. */
function tidy(text: string): string {
  return text.replace(new RegExp(`[ \\t]+(?=${MARK_OPEN})`, 'g'), '')
    .replace(/[ \t]+([.,;:!?)])/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
}
