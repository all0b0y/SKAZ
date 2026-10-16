/**
 * Test oracle only — never imported by the app. Verbatim copies of
 * NativeHistory.snapshot() and nativeParts() as they were before the
 * incremental rewrite (2026-09-25), so equivalence tests compare the new code
 * against the old behaviour instead of against itself.
 */
import type { NativeEventPage, NativeTurnOwner } from '../api/nativeEventPages';
import type { NativeSnapshot, NativeTranscriptToken, NativeTranslationProjection } from '../api/nativeLive';
import type { NativePart, ReadingChunk, ReadingSnapshot } from '../components/transcript/nativeParts';

type Event = NativeEventPage['events'][number];

export class ReferenceHistory {
  revision = 0;
  private events = new Map<string, Map<number, Event>>();
  private ranges = new Map<string, { first: number; last: number }>();
  private order: string[] = [];
  private pages = new Map<string, NativeEventPage>();
  private groups: Record<string, NativeTurnOwner | null> = {};
  private latest: NativeEventPage | null = null;

  merge(page: NativeEventPage, direction: 'older' | 'newer'): void {
    if (!this.latest || this.latest.transcription !== page.transcription) this.revision++;
    this.latest = page;
    if (!page.connection) return;
    if (!page.projection) throw new Error('Native page projection is missing.');
    const cid = page.connection.id;
    const old = this.pages.get(cid);
    const groupChanged = Object.entries(page.projection.groups)
      .some(([id, owner]) => JSON.stringify(owner) !== JSON.stringify(this.groups[id]));
    if (!old) direction === 'older' ? this.order.unshift(cid) : this.order.push(cid);
    Object.assign(this.groups, page.projection.groups);
    const records = this.events.get(cid) ?? new Map<number, Event>();
    const range = this.ranges.get(cid) ?? { first: page.next_before, last: page.next_after };
    let added = false;
    for (const event of page.events) {
      if (!records.has(event.ordinal)) { records.set(event.ordinal, event); added = true; }
      range.first = Math.min(range.first, event.ordinal);
      range.last = Math.max(range.last, event.ordinal);
    }
    this.events.set(cid, records); this.ranges.set(cid, range);
    const tail = direction === 'older' && old ? old.projection?.tail ?? null : page.projection.tail;
    if (!old || added || groupChanged || old.connection?.status !== page.connection.status
      || old.connection?.end_sample !== page.connection.end_sample
      || JSON.stringify(old.projection?.tail) !== JSON.stringify(tail)
      || JSON.stringify(old.projection?.tail_groups) !== JSON.stringify(page.projection.tail_groups)) this.revision++;
    this.pages.set(cid, { ...page, events: [], tail: null, projection: { ...page.projection, groups: {}, tail } });
  }

  snapshot(): ReadingSnapshot | null {
    const page = this.latest;
    if (!page) return null;
    const projection: NativeTranslationProjection = { original_tokens: [], translation_tokens: [], monologues: [],
      unassigned_translation_token_ids: [], order_unavailable_connection_ids: [] };
    const readingChunks: ReadingChunk[] = [];
    const turns = new Map<string, NativeTranslationProjection['monologues'][number]>();
    const turn = (owner: NativeTurnOwner) => {
      let value = turns.get(owner.id);
      if (!value) {
        value = { ...owner, original_token_ids: [], translation_token_ids: [], passthrough_token_ids: [], display_token_ids: [] };
        turns.set(owner.id, value);
      }
      return value;
    };
    for (const cid of this.order) {
      const info = this.pages.get(cid)!;
      const available = info.projection!.available;
      if (!available) projection.order_unavailable_connection_ids.push(cid);
      const events: Array<Pick<Event, 'originals' | 'translations' | 'order' | 'projection'> & { ordinal?: number }> =
        [...(this.events.get(cid)?.values() ?? [])].sort((a, b) => a.ordinal - b.ordinal);
      const last = this.ranges.get(cid)?.last ?? info.next_after;
      if (last >= info.through && info.projection?.tail) events.push(info.projection.tail);
      let status: string | null = null;
      let chunk: ReadingChunk | null = null;
      for (const event of events) {
        const meta = event.projection;
        if (!meta) throw new Error('Native event ownership is missing.');
        projection.original_tokens.push(...event.originals);
        projection.translation_tokens.push(...event.translations.map(token => ({ ...token, window_anchor: `${cid}:${event.ordinal ?? 'tail'}` })));
        for (const token of event.originals) {
          const owner = meta.owners[token.id];
          if (owner) turn(owner).original_token_ids.push(token.id);
        }
        if (!available) readingChunks.push({ originals: event.originals.map(t => t.id),
          translations: event.translations.map(t => t.id), atomic: false });
        const assigned = new Set<string>();
        for (const ref of available ? event.order ?? [] : []) {
          if (!chunk || (ref.translation_status !== status && ref.translation_status !== 'translation')
            || (ref.translation_status === 'translation' && status === 'none')) {
            chunk = { originals: [], translations: [], atomic: ref.translation_status !== 'none' };
            readingChunks.push(chunk);
          }
          (ref.translation_status === 'translation' ? chunk.translations : chunk.originals).push(ref.id);
          status = ref.translation_status;
          if (ref.translation_status === 'none') {
            const owner = meta.owners[ref.id];
            if (owner) { turn(owner).passthrough_token_ids.push(ref.id); turn(owner).display_token_ids.push(ref.id); }
          } else if (ref.translation_status === 'translation') {
            const group = meta.translations[ref.id] ?? '';
            const overlay = info.projection?.tail_groups ?? {};
            const owner = Object.hasOwn(overlay, group) ? overlay[group] : this.groups[group];
            if (owner) {
              turn(owner).translation_token_ids.push(ref.id); turn(owner).display_token_ids.push(ref.id);
              assigned.add(ref.id);
            }
          }
        }
        projection.unassigned_translation_token_ids.push(...event.translations.filter(t => !assigned.has(t.id)).map(t => t.id));
      }
    }
    projection.monologues = [...turns.values()].sort((a, b) => (a.start_sample ?? 0) - (b.start_sample ?? 0));
    const connections = this.order.flatMap(cid => {
      const connection = this.pages.get(cid)?.connection;
      return connection ? [{ ...connection, draft_json: '[]' }] : [];
    });
    return { readingChunks, session_id: page.session_id, sample_rate: page.sample_rate, saved_samples: page.saved_samples,
      next_sequence: 0, recording_mode: page.recording_mode, translation_target_language: page.translation_target_language,
      transcription: page.transcription ?? (connections.some(c => c.status === 'active') ? 'streaming' : 'inactive'),
      final_tokens: projection.original_tokens, final_translation_tokens: projection.translation_tokens,
      live_translation_projection: projection, connections,
      gaps: connections.filter(c => c.status !== 'active' && c.final_sample < (c.end_sample ?? 0))
        .map(c => ({ start_sample: c.final_sample, end_sample: c.end_sample! })),
    };
  }
}

const PART_SECONDS = 30 * 60;
const sentenceEnd = /[.!?…]["'»”’\])]*\s*$/u;

function sentences(tokens: NativeTranscriptToken[]): NativeTranscriptToken[][] {
  const result: NativeTranscriptToken[][] = [];
  let sentence: NativeTranscriptToken[] = [];
  for (const token of tokens) {
    const last = sentence.at(-1);
    if (last && (last.connection_id !== token.connection_id || last.speaker_number !== token.speaker_number)) {
      result.push(sentence); sentence = [];
    }
    sentence.push(token);
    if (sentenceEnd.test(token.text)) { result.push(sentence); sentence = []; }
  }
  if (sentence.length) result.push(sentence);
  return result;
}

export function referenceParts(snapshot: ReadingSnapshot): NativePart[] {
  const projection = snapshot.live_translation_projection;
  const originals = projection?.original_tokens ?? snapshot.final_tokens ?? [];
  const byId = new Map(originals.map(token => [token.id, token]));
  const translated = projection?.translation_tokens ?? snapshot.final_translation_tokens ?? [];
  const chunks = snapshot.readingChunks ?? [];
  const units: Array<{ tokens: NativeTranscriptToken[]; translations: string[] }> = [];
  const represented = new Set<string>();
  for (const chunk of chunks) {
    const tokens = chunk.originals.flatMap(id => {
      const token = byId.get(id);
      if (!token || represented.has(id)) return [];
      represented.add(id); return [token];
    });
    if (chunk.atomic) units.push({ tokens, translations: chunk.translations });
    else {
      for (const sentence of sentences(tokens)) units.push({ tokens: sentence, translations: [] });
      if (chunk.translations.length) units.push({ tokens: [], translations: chunk.translations });
    }
  }
  for (const sentence of sentences(originals.filter(token => !represented.has(token.id)))) {
    units.push({ tokens: sentence, translations: [] });
  }
  const pages: Array<{ tokens: NativeTranscriptToken[]; translations: Set<string>; start: number; end: number;
    translationStartPart: number | null }> = [];
  const limit = PART_SECONDS * snapshot.sample_rate;
  const addPage = (start: number) => {
    const page = { tokens: [] as NativeTranscriptToken[], translations: new Set<string>(), start, end: start,
      translationStartPart: null as number | null };
    pages.push(page); return page;
  };
  for (const unit of units) {
    const first = unit.tokens[0];
    let page = pages.at(-1) ?? addPage(first?.start_sample ?? 0);
    if (first) {
      const end = unit.tokens.reduce((end, token) => Math.max(end, token.end_sample), first.end_sample);
      if (page.tokens.length && end - page.start > limit && end - first.start_sample <= limit) {
        page = addPage(first.start_sample);
      }
    }
    let translationPage = pages.length - 1;
    for (const [index, token] of unit.tokens.entries()) {
      if (page.tokens.length && token.end_sample - page.start > limit) page = addPage(token.start_sample);
      if (index === 0) translationPage = pages.length - 1;
      page.tokens.push(token);
      page.end = Math.max(page.end, token.end_sample);
      if (unit.translations.length && pages.length - 1 !== translationPage) page.translationStartPart = translationPage;
    }
    for (const id of unit.translations) pages[translationPage]!.translations.add(id);
  }
  if (!pages.length) addPage(0);
  const tokenPage = new Map(pages.flatMap((page, index) => page.tokens.map(token => [token.id, index] as const)));
  const allocated = new Set(pages.flatMap(page => [...page.translations]));
  for (const turn of projection?.monologues ?? []) {
    const first = turn.original_token_ids.map(id => tokenPage.get(id)).find(index => index !== undefined) ?? 0;
    for (const id of turn.translation_token_ids) {
      if (!allocated.has(id)) { pages[first]!.translations.add(id); allocated.add(id); }
    }
    if (!chunks.length && turn.translation_token_ids.length) {
      for (const id of turn.original_token_ids) {
        const index = tokenPage.get(id);
        if (index !== undefined && index !== first) pages[index]!.translationStartPart = first;
      }
    }
  }
  for (const token of translated) {
    if (!allocated.has(token.id)) pages[0]!.translations.add(token.id);
  }
  return pages.map((page, index) => {
    const ids = new Set(page.tokens.map(token => token.id));
    const visible = new Set([...ids, ...page.translations]);
    const localProjection: NativeTranslationProjection | undefined = projection ? {
      ...projection, original_tokens: page.tokens,
      translation_tokens: translated.filter(token => page.translations.has(token.id)),
      unassigned_translation_token_ids: projection.unassigned_translation_token_ids.filter(id => page.translations.has(id)),
      monologues: projection.monologues.map(turn => ({
        ...turn,
        start_sample: turn.original_token_ids.map(id => byId.get(id)).find(token => token && ids.has(token.id))?.start_sample ?? turn.start_sample,
        original_token_ids: turn.original_token_ids.filter(id => ids.has(id)),
        translation_token_ids: turn.translation_token_ids.filter(id => page.translations.has(id)),
        passthrough_token_ids: turn.passthrough_token_ids.filter(id => ids.has(id)),
        display_token_ids: turn.display_token_ids.filter(id => visible.has(id)),
      })).filter(turn => turn.original_token_ids.length || turn.display_token_ids.length),
    } : undefined;
    const first = page.tokens[0];
    const previous = pages[index - 1]?.tokens.at(-1);
    return {
      id: first?.id ?? `empty:${snapshot.session_id}`, start: page.start, end: page.end,
      continuesPrevious: Boolean(first && previous && first.connection_id === previous.connection_id
        && first.speaker_number === previous.speaker_number),
      translationStartPart: page.translationStartPart,
      snapshot: { ...snapshot, final_tokens: page.tokens,
        final_translation_tokens: translated.filter(token => page.translations.has(token.id)),
        live_translation_projection: localProjection },
    };
  });
}

/** The only intended output difference: parts no longer carry `readingChunks`. */
export function withoutChunks(parts: NativePart[]): NativePart[] {
  return parts.map(part => {
    const { readingChunks: _chunks, ...snapshot } = part.snapshot as NativeSnapshot & { readingChunks?: unknown };
    return { ...part, snapshot };
  });
}
