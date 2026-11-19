export interface RenderedChatRun {
  readonly messageId: string;
  readonly text: string;
  /** A visual block boundary within this message, such as another paragraph or table cell. */
  readonly breakBefore?: boolean;
}

export interface ChatMatchRange {
  readonly runIndex: number;
  /** Half-open UTF-16 offsets in the original run. */
  readonly start: number;
  readonly end: number;
}

export interface ChatMatch {
  readonly id: string;
  readonly messageId: string;
  readonly ranges: readonly ChatMatchRange[];
}

export interface ChatFindResult {
  readonly matches: readonly ChatMatch[];
  readonly activeMatch: ChatMatch | null;
  /** Zero-based, or -1 when there are no results. */
  readonly activeIndex: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Map normalized offsets back to the full original grapheme when normalization changed it. */
function originalOffsets(text: string, normalized: string) {
  if (text === normalized) return null;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const nfc = segment.normalize('NFC');
    for (let i = 0; i < nfc.length; i++) {
      starts.push(segment === nfc ? index + i : index);
      ends.push(segment === nfc ? index + i + 1 : index + segment.length);
    }
  }
  return { starts, ends };
}

/** Runs are ordered by message and reading order. Inline runs join, while visual blocks stay separate. */
export function findChatMatches(runs: readonly RenderedChatRun[], query: string): ChatMatch[] {
  const term = query.normalize('NFC').trim();
  if (!term) return [];
  const escaped = term.split(/\s+/u).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('\\s+'), 'giu');
  const matches: ChatMatch[] = [];
  let messageId: string | undefined;
  let messageOffset = 0;

  for (let startRun = 0; startRun < runs.length;) {
    const first = runs[startRun]!;
    if (messageId !== first.messageId) {
      messageId = first.messageId;
      messageOffset = 0;
    }
    const ends: number[] = [];
    let text = '';
    let nextRun = startRun;
    for (; nextRun < runs.length; nextRun++) {
      const run = runs[nextRun]!;
      if (nextRun > startRun && (run.messageId !== messageId || run.breakBefore)) break;
      text += run.text;
      ends.push(text.length);
    }

    const normalized = text.normalize('NFC');
    const offsets = originalOffsets(text, normalized);
    let firstRange = 0;
    for (const hit of normalized.matchAll(pattern)) {
      const from = hit.index;
      const to = from + hit[0].length;
      const start = offsets?.starts[from] ?? from;
      const end = offsets?.ends[to - 1] ?? to;
      while (ends[firstRange]! <= start) firstRange++;
      const ranges: ChatMatchRange[] = [];
      for (let i = firstRange; i < ends.length; i++) {
        const runStart = ends[i - 1] ?? 0;
        const runEnd = ends[i]!;
        if (runStart >= end) break;
        if (runStart < runEnd) ranges.push({
          runIndex: startRun + i,
          start: Math.max(start - runStart, 0),
          end: Math.min(end, runEnd) - runStart,
        });
      }
      // Message-relative positions survive streaming appends and changes to inline DOM nodes.
      matches.push({ id: JSON.stringify([messageId, messageOffset + from, to - from]), messageId, ranges });
    }
    messageOffset += normalized.length + 1;
    startRun = nextRun;
  }
  return matches;
}

function resultAt(matches: readonly ChatMatch[], index: number): ChatFindResult {
  return matches.length
    ? { matches, activeIndex: index, activeMatch: matches[index]! }
    : { matches, activeIndex: -1, activeMatch: null };
}

/** Keep the active ID across a refresh, or the nearest valid ordinal if the hit disappeared. */
export function retainChatMatch(matches: readonly ChatMatch[], previous?: ChatFindResult): ChatFindResult {
  const index = previous?.activeMatch ? matches.findIndex((match) => match.id === previous.activeMatch?.id) : -1;
  return resultAt(matches, index >= 0 ? index : Math.min(Math.max(previous?.activeIndex ?? 0, 0), matches.length - 1));
}

export function moveChatMatch(result: ChatFindResult, direction: 1 | -1): ChatFindResult {
  const count = result.matches.length;
  return count ? resultAt(result.matches, (result.activeIndex + direction + count) % count) : result;
}
