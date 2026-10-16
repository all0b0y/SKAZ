import type { NativeSnapshot, NativeTranscriptToken, NativeTranslationProjection } from '../../api/nativeLive';

/** Display grouping only; never changes ASR IDs, timestamps or translation ownership. */
export interface ReadingChunk {
  originals: string[];
  translations: string[];
  atomic: boolean;
}
export interface ReadingSnapshot extends NativeSnapshot { readingChunks?: ReadingChunk[] }
export interface NativePart {
  id: string;
  start: number;
  end: number;
  snapshot: NativeSnapshot;
  continuesPrevious: boolean;
  translationStartPart: number | null;
}
export const PART_SECONDS = 30 * 60;
const sentenceEnd = /[.!?…]["'»”’\])]*\s*$/u;

/** [start, end) ranges of `tokens`, split exactly as reading sentences. */
function sentenceRanges(tokens: NativeTranscriptToken[]): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const last = i > start ? tokens[i - 1]! : undefined;
    if (last && (last.connection_id !== token.connection_id || last.speaker_number !== token.speaker_number)) {
      result.push([start, i]); start = i;
    }
    if (sentenceEnd.test(token.text)) { result.push([start, i + 1]); start = i + 1; }
  }
  if (start < tokens.length) result.push([start, tokens.length]);
  return result;
}

/** Per part: the tokens of the reading unit that opened it, when the part
 * begins exactly at a unit start (null when a long unit overflowed into it). */
export type PartMark = NativeTranscriptToken[] | null;
export interface PartsBuild {
  parts: NativePart[];
  marks: PartMark[];
  /** Nonzero when a fallback reached beyond stream order (leftover originals,
   * dropped ids, or translations placed by monologue/first-part fallback). */
  irregular: number;
}

/** Parts are whole reading surfaces, not transport pages or an evicting event window. */
export function nativeParts(snapshot: ReadingSnapshot): NativePart[] {
  return buildNativeParts(snapshot).parts;
}

export function buildNativeParts(snapshot: ReadingSnapshot): PartsBuild {
  // Chunks only drive grouping here; parts never expose them (no consumer reads them).
  const { readingChunks: _chunks, ...base } = snapshot;
  const projection = snapshot.live_translation_projection;
  const originals = projection?.original_tokens ?? snapshot.final_tokens ?? [];
  const byId = new Map(originals.map(token => [token.id, token]));
  const translated = projection?.translation_tokens ?? snapshot.final_translation_tokens ?? [];
  const chunks = snapshot.readingChunks ?? [];
  const units: Array<{ tokens: NativeTranscriptToken[]; translations: string[] }> = [];
  const represented = new Set<string>();
  let irregular = 0;
  for (const chunk of chunks) {
    const tokens: NativeTranscriptToken[] = [];
    for (const id of chunk.originals) {
      const token = byId.get(id);
      if (!token || represented.has(id)) { irregular += 1; continue; }
      represented.add(id); tokens.push(token);
    }
    if (chunk.atomic) units.push({ tokens, translations: chunk.translations });
    else {
      for (const [start, end] of sentenceRanges(tokens)) units.push({ tokens: tokens.slice(start, end), translations: [] });
      if (chunk.translations.length) units.push({ tokens: [], translations: chunk.translations });
    }
  }
  const leftovers = originals.filter(token => !represented.has(token.id));
  irregular += leftovers.length;
  for (const [start, end] of sentenceRanges(leftovers)) units.push({ tokens: leftovers.slice(start, end), translations: [] });
  // Untimed translation-only chunks retain stream order beside the preceding chunk.
  // They still render in the explicitly unassigned section when ownership is unknown.
  const pages: Array<{ tokens: NativeTranscriptToken[]; translations: Set<string>; start: number; end: number;
    translationStartPart: number | null }> = [];
  const marks: PartMark[] = [];
  const limit = PART_SECONDS * snapshot.sample_rate;
  const addPage = (start: number, mark: PartMark) => {
    const page = { tokens: [] as NativeTranscriptToken[], translations: new Set<string>(), start, end: start,
      translationStartPart: null as number | null };
    pages.push(page); marks.push(mark); return page;
  };
  for (const unit of units) {
    const first = unit.tokens[0];
    let page = pages.at(-1) ?? addPage(first?.start_sample ?? 0, first ? unit.tokens : null);
    if (first) {
      const end = unit.tokens.reduce((end, token) => Math.max(end, token.end_sample), first.end_sample);
      if (page.tokens.length && end - page.start > limit && end - first.start_sample <= limit) {
        page = addPage(first.start_sample, unit.tokens);
      }
    }
    let translationPage = pages.length - 1;
    for (const [index, token] of unit.tokens.entries()) {
      if (page.tokens.length && token.end_sample - page.start > limit) {
        page = addPage(token.start_sample, index === 0 ? unit.tokens : null);
      }
      if (index === 0) translationPage = pages.length - 1;
      page.tokens.push(token);
      page.end = Math.max(page.end, token.end_sample);
      if (unit.translations.length && pages.length - 1 !== translationPage) page.translationStartPart = translationPage;
    }
    for (const id of unit.translations) pages[translationPage]!.translations.add(id);
  }
  if (!pages.length) addPage(0, null);
  const tokenPage = new Map(pages.flatMap((page, index) => page.tokens.map(token => [token.id, index] as const)));
  const allocated = new Set(pages.flatMap(page => [...page.translations]));
  // Older snapshots have monologue-level provenance, not stream chunks. Keep their
  // undivided translation at the first source; do not infer word-level alignment.
  for (const turn of projection?.monologues ?? []) {
    const first = turn.original_token_ids.map(id => tokenPage.get(id)).find(index => index !== undefined) ?? 0;
    for (const id of turn.translation_token_ids) {
      if (!allocated.has(id)) { pages[first]!.translations.add(id); allocated.add(id); irregular += 1; }
    }
    if (!chunks.length && turn.translation_token_ids.length) {
      irregular += 1;
      for (const id of turn.original_token_ids) {
        const index = tokenPage.get(id);
        if (index !== undefined && index !== first) pages[index]!.translationStartPart = first;
      }
    }
  }
  for (const token of translated) {
    if (!allocated.has(token.id)) { pages[0]!.translations.add(token.id); irregular += 1; }
  }
  // Split every id list across parts in ONE pass. Filtering each list once per
  // part re-read a live monologue (the whole history of one speaker) for every
  // part on every 1 s poll. Order within each part is the list order, as before.
  const originalPages = new Map<string, number[]>();
  const translationPages = new Map<string, number[]>();
  const note = (map: Map<string, number[]>, id: string, index: number) => {
    const list = map.get(id);
    if (!list) map.set(id, [index]); else if (list.at(-1) !== index) list.push(index);
  };
  pages.forEach((page, index) => {
    for (const token of page.tokens) note(originalPages, token.id, index);
    for (const id of page.translations) note(translationPages, id, index);
  });
  const none: number[] = [];
  const split = <T>(items: readonly T[], where: (item: T) => readonly number[]): T[][] => {
    const result = pages.map((): T[] => []);
    for (const item of items) for (const index of where(item)) result[index]!.push(item);
    return result;
  };
  const inTranslations = (id: string) => translationPages.get(id) ?? none;
  const inOriginals = (id: string) => originalPages.get(id) ?? none;
  const inVisible = (id: string) => {
    const a = inOriginals(id); const b = inTranslations(id);
    return !b.length ? a : !a.length ? b : [...new Set([...a, ...b])];
  };
  const translatedByPage = split(translated, token => inTranslations(token.id));
  const unassignedByPage = split(projection?.unassigned_translation_token_ids ?? [], inTranslations);
  const turnsByPage = (projection?.monologues ?? []).map(turn => ({
    originals: split(turn.original_token_ids, inOriginals),
    translations: split(turn.translation_token_ids, inTranslations),
    passthrough: split(turn.passthrough_token_ids, inOriginals),
    display: split(turn.display_token_ids, inVisible),
  }));
  const parts = pages.map((page, index) => {
    const localProjection: NativeTranslationProjection | undefined = projection ? {
      ...projection, original_tokens: page.tokens,
      translation_tokens: translatedByPage[index]!,
      unassigned_translation_token_ids: unassignedByPage[index]!,
      monologues: projection.monologues.map((turn, t) => {
        const own = turnsByPage[t]!;
        const first = own.originals[index]!.map(id => byId.get(id)).find(Boolean);
        return {
          ...turn,
          start_sample: first?.start_sample ?? turn.start_sample,
          original_token_ids: own.originals[index]!,
          translation_token_ids: own.translations[index]!,
          passthrough_token_ids: own.passthrough[index]!,
          display_token_ids: own.display[index]!,
        };
      }).filter(turn => turn.original_token_ids.length || turn.display_token_ids.length),
    } : undefined;
    const first = page.tokens[0];
    const previous = pages[index - 1]?.tokens.at(-1);
    return {
      id: first?.id ?? `empty:${snapshot.session_id}`, start: page.start, end: page.end,
      continuesPrevious: Boolean(first && previous && first.connection_id === previous.connection_id
        && first.speaker_number === previous.speaker_number),
      translationStartPart: page.translationStartPart,
      snapshot: { ...base, final_tokens: page.tokens,
        final_translation_tokens: translatedByPage[index]!,
        live_translation_projection: localProjection },
    };
  });
  return { parts, marks, irregular };
}
