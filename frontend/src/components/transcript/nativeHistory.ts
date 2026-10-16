import type { NativeEventPage, NativeEventPageQuery, NativeTurnOwner } from '../../api/nativeEventPages';
import type { NativeSnapshot, NativeTranscriptToken, NativeTranslationProjection, NativeTranslationToken } from '../../api/nativeLive';

import { buildNativeParts, PART_SECONDS, type NativePart, type PartsBuild, type ReadingChunk, type ReadingSnapshot } from './nativeParts';

type Event = NativeEventPage['events'][number];
type Monologue = NativeTranslationProjection['monologues'][number];
type Ordered = Pick<Event, 'originals' | 'translations' | 'order' | 'projection'> & { ordinal?: number };
type OwnerOf = (group: string) => NativeTurnOwner | null | undefined;

/** The flat reading stream: what snapshot() exposes, built event by event. */
interface Flat {
  originals: NativeTranscriptToken[];
  translations: NativeTranslationToken[];
  chunks: ReadingChunk[];
  turns: Map<string, Monologue>;
  unassigned: string[];
  /** Any translation token or translation-ordered ref was seen. */
  translated: boolean;
}
/** Stream-order chunking state within one connection. */
interface StreamState { status: string | null; chunk: ReadingChunk | null }

/** Append-only stream of every merged event (never tails), extended per poll. */
interface Live {
  flat: Flat;
  order: string[];
  last: Map<string, number>;
  available: Map<string, boolean>;
  /** Chunking state of the last connection, continued by its next events. */
  state: StreamState;
  generation: number;
}

/** Closed thirty-minute parts from the last full build and where the open part begins. */
interface Frozen {
  generation: number;
  sampleRate: number;
  closed: NativePart[];
  /** Index in the live stream of the open part's first token. */
  boundary: number;
  first: NativeTranscriptToken;
  /** Start of the last closed part, needed to re-check the split decision. */
  start: number;
}

const emptyFlat = (): Flat => ({ originals: [], translations: [], chunks: [], turns: new Map(), unassigned: [], translated: false });
const noOwner: OwnerOf = () => undefined;

function turnOf(turns: Map<string, Monologue>, owner: NativeTurnOwner): Monologue {
  let value = turns.get(owner.id);
  if (!value) {
    value = { ...owner, original_token_ids: [], translation_token_ids: [], passthrough_token_ids: [], display_token_ids: [] };
    turns.set(owner.id, value);
  }
  return value;
}

/** Adds one event (or a tail) to the flat stream. This is the per-event body of
 * the original snapshot loop, unchanged, so full and incremental builds agree. */
function applyEvent(flat: Flat, cid: string, event: Ordered, available: boolean, state: StreamState, ownerOf: OwnerOf): void {
  const meta = event.projection;
  if (!meta) throw new Error('Native event ownership is missing.');
  flat.originals.push(...event.originals);
  flat.translations.push(...event.translations.map(token => ({ ...token, window_anchor: `${cid}:${event.ordinal ?? 'tail'}` })));
  if (event.translations.length) flat.translated = true;
  for (const token of event.originals) {
    const owner = meta.owners[token.id];
    if (owner) turnOf(flat.turns, owner).original_token_ids.push(token.id);
  }
  if (!available) flat.chunks.push({ originals: event.originals.map(t => t.id),
    translations: event.translations.map(t => t.id), atomic: false });
  const assigned = new Set<string>();
  for (const ref of available ? event.order ?? [] : []) {
    if (ref.translation_status !== 'none') flat.translated = true;
    if (!state.chunk || (ref.translation_status !== state.status && ref.translation_status !== 'translation')
      || (ref.translation_status === 'translation' && state.status === 'none')) {
      state.chunk = { originals: [], translations: [], atomic: ref.translation_status !== 'none' };
      flat.chunks.push(state.chunk);
    }
    (ref.translation_status === 'translation' ? state.chunk.translations : state.chunk.originals).push(ref.id);
    state.status = ref.translation_status;
    if (ref.translation_status === 'none') {
      const owner = meta.owners[ref.id];
      if (owner) { turnOf(flat.turns, owner).passthrough_token_ids.push(ref.id); turnOf(flat.turns, owner).display_token_ids.push(ref.id); }
    } else if (ref.translation_status === 'translation') {
      const owner = ownerOf(meta.translations[ref.id] ?? '');
      if (owner) {
        turnOf(flat.turns, owner).translation_token_ids.push(ref.id); turnOf(flat.turns, owner).display_token_ids.push(ref.id);
        assigned.add(ref.id);
      }
    }
  }
  flat.unassigned.push(...event.translations.filter(t => !assigned.has(t.id)).map(t => t.id));
}

/** The ids of `list` that belong to the stream suffix `ids` (lists follow stream order). */
function suffix(list: string[], ids: Set<string>): string[] {
  let start = list.length;
  while (start > 0 && ids.has(list[start - 1]!)) start -= 1;
  return list.slice(start);
}

/**
 * Durable-source cache. Transport pages never evict a visible reading part.
 *
 * Reading parts are cut every thirty minutes. A live poll used to rebuild the
 * whole history and re-cut it every second, so its cost grew with recording
 * length (.dev/docs/LIVE-CPU-PROFILE-20260925.md). Events are append-only, so
 * `parts()` keeps the closed parts and rebuilds only the open one from where it
 * begins; every precondition for that reuse is checked on each read, and any
 * doubt falls back to the full build. The output is identical to the full
 * build (nativeHistory.incremental.test.ts compares with the previous code).
 */
export class NativeHistory {
  revision = 0;
  private events = new Map<string, Map<number, Event>>();
  private ranges = new Map<string, { first: number; last: number }>();
  private order: string[] = [];
  private pages = new Map<string, NativeEventPage>();
  private groups: Record<string, NativeTurnOwner | null> = {};
  private latest: NativeEventPage | null = null;
  /** Events merged since the live stream last consumed them, per connection. */
  private pending = new Map<string, Event[]>();
  private live: Live | null = null;
  private generation = 0;
  private frozen: Frozen | null = null;
  private partsCache: { revision: number; latest: NativeEventPage | null; parts: NativePart[] } | null = null;

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
      if (!records.has(event.ordinal)) {
        records.set(event.ordinal, event); added = true;
        const pending = this.pending.get(cid);
        if (pending) pending.push(event); else this.pending.set(cid, [event]);
      }
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

  query(direction: 'older' | 'newer'): NativeEventPageQuery | null {
    const cid = direction === 'older' ? this.order[0] : this.order.at(-1);
    const page = cid ? this.pages.get(cid) : undefined;
    if (!page?.connection) return null;
    const range = this.ranges.get(page.connection.id)!;
    if (direction === 'older') {
      if (range.first > 0) return { connection_id: page.connection.id, before: range.first };
      return page.previous_connection_id ? { connection_id: page.previous_connection_id } : null;
    }
    if (range.last < page.through || !page.next_connection_id) return { connection_id: page.connection.id, after: range.last };
    return { connection_id: page.next_connection_id, after: -1 };
  }

  get hasNewer(): boolean {
    const cid = this.order.at(-1);
    const page = cid ? this.pages.get(cid) : undefined;
    if (!page?.connection) return false;
    return this.ranges.get(page.connection.id)!.last < page.through || page.next_connection_id !== null;
  }

  /** The snapshot's transcription state without building the snapshot. */
  get transcription(): NativeSnapshot['transcription'] | null {
    const page = this.latest;
    if (!page) return null;
    return page.transcription
      ?? (this.order.some(cid => this.pages.get(cid)?.connection?.status === 'active') ? 'streaming' : 'inactive');
  }

  /** Full flat reading snapshot of everything merged (O(history); not on the poll path). */
  snapshot(): ReadingSnapshot | null {
    const page = this.latest;
    if (!page) return null;
    const flat = emptyFlat();
    for (const cid of this.order) {
      const info = this.pages.get(cid)!;
      const available = info.projection!.available;
      const events: Ordered[] = [...(this.events.get(cid)?.values() ?? [])].sort((a, b) => a.ordinal - b.ordinal);
      if (this.tailIncluded(cid)) events.push(info.projection!.tail!);
      const state: StreamState = { status: null, chunk: null };
      for (const event of events) applyEvent(flat, cid, event, available, state, this.ownerOf(info));
    }
    return this.assemble(page, flat);
  }

  /** Thirty-minute reading parts; closed parts are reused while provably unchanged. */
  parts(): NativePart[] {
    const cache = this.partsCache;
    if (cache && cache.revision === this.revision && cache.latest === this.latest) return cache.parts;
    const parts = this.buildParts();
    this.partsCache = { revision: this.revision, latest: this.latest, parts };
    return parts;
  }

  private ownerOf(info: NativeEventPage): OwnerOf {
    const overlay = info.projection?.tail_groups ?? {};
    return group => Object.hasOwn(overlay, group) ? overlay[group] : this.groups[group];
  }

  private tailIncluded(cid: string): boolean {
    const info = this.pages.get(cid)!;
    const last = this.ranges.get(cid)?.last ?? info.next_after;
    return last >= info.through && Boolean(info.projection?.tail);
  }

  private assemble(page: NativeEventPage, flat: Flat): ReadingSnapshot {
    const projection: NativeTranslationProjection = { original_tokens: flat.originals, translation_tokens: flat.translations,
      monologues: [...flat.turns.values()].sort((a, b) => (a.start_sample ?? 0) - (b.start_sample ?? 0)),
      unassigned_translation_token_ids: flat.unassigned,
      order_unavailable_connection_ids: this.order.filter(cid => !this.pages.get(cid)!.projection!.available) };
    const connections = this.order.flatMap(cid => {
      const connection = this.pages.get(cid)?.connection;
      return connection ? [{ ...connection, draft_json: '[]' }] : [];
    });
    return { readingChunks: flat.chunks, session_id: page.session_id, sample_rate: page.sample_rate, saved_samples: page.saved_samples,
      next_sequence: 0, recording_mode: page.recording_mode, translation_target_language: page.translation_target_language,
      transcription: page.transcription ?? (connections.some(c => c.status === 'active') ? 'streaming' : 'inactive'),
      final_tokens: projection.original_tokens, final_translation_tokens: projection.translation_tokens,
      live_translation_projection: projection, connections,
      gaps: connections.filter(c => c.status !== 'active' && c.final_sample < (c.end_sample ?? 0))
        .map(c => ({ start_sample: c.final_sample, end_sample: c.end_sample! })),
    };
  }

  private buildParts(): NativePart[] {
    const snapshot0 = this.latest;
    if (!snapshot0) return [];
    const live = this.syncLive();
    const reused = this.reuse(live);
    if (reused) return reused;
    const build = buildNativeParts(this.snapshot()!);
    this.freeze(live, build);
    return build.parts;
  }

  /** Brings the live stream up to date with merged events, or rebuilds it. */
  private syncLive(): Live {
    if (this.live && this.extend(this.live)) return this.live;
    const live: Live = { flat: emptyFlat(), order: [], last: new Map(), available: new Map(),
      state: { status: null, chunk: null }, generation: ++this.generation };
    this.pending.clear();
    this.live = live;
    this.extend(live);
    return live;
  }

  private extend(live: Live): boolean {
    const known = live.order.length;
    if (this.order.length < known) return false;
    for (let i = 0; i < known; i += 1) {
      const cid = live.order[i]!;
      if (this.order[i] !== cid || this.pages.get(cid)!.projection!.available !== live.available.get(cid)) return false;
      // Only the last connection may still grow, and only past what it holds.
      if (i < known - 1 && this.pending.get(cid)?.length) return false;
    }
    const lastCid = live.order.at(-1);
    const pending = lastCid === undefined ? undefined : this.pending.get(lastCid);
    if (lastCid !== undefined && pending?.length) {
      pending.sort((a, b) => a.ordinal - b.ordinal);
      if (pending[0]!.ordinal <= (live.last.get(lastCid) ?? -Infinity)) return false;
      for (const event of pending) applyEvent(live.flat, lastCid, event, live.available.get(lastCid)!, live.state, noOwner);
      live.last.set(lastCid, pending.at(-1)!.ordinal);
      pending.length = 0;
    }
    for (let i = known; i < this.order.length; i += 1) {
      const cid = this.order[i]!;
      const available = this.pages.get(cid)!.projection!.available;
      live.order.push(cid); live.available.set(cid, available);
      live.state = { status: null, chunk: null };
      const events = [...(this.events.get(cid)?.values() ?? [])].sort((a, b) => a.ordinal - b.ordinal);
      for (const event of events) applyEvent(live.flat, cid, event, available, live.state, noOwner);
      live.last.set(cid, events.at(-1)?.ordinal ?? -Infinity);
      this.pending.delete(cid);
    }
    return true;
  }

  /** Reuse holds only for stream-ordered originals with no translations and no
   * replaceable tail in the middle of the stream (a finished connection's tail).
   * An empty tail — what an ended connection normally reports — adds nothing. */
  private reusable(live: Live): boolean {
    return !live.flat.translated && !this.order.slice(0, -1).some(cid => {
      const tail = this.pages.get(cid)!.projection?.tail;
      return this.tailIncluded(cid) && Boolean(tail && (tail.originals.length || tail.translations.length
        || tail.order.length || !this.pages.get(cid)!.projection!.available));
    });
  }

  private freeze(live: Live, build: PartsBuild): void {
    this.frozen = null;
    const closedCount = build.parts.length - 1;
    const mark = build.marks[closedCount];
    // Only a part that opens exactly at a reading unit, in a stream the reuse
    // path can reproduce, may be frozen. Anything else keeps the full build.
    if (closedCount < 1 || !mark?.length || build.irregular !== 0 || !this.reusable(live)) return;
    const closed = build.parts.slice(0, closedCount);
    const boundary = closed.reduce((count, part) => count + (part.snapshot.final_tokens?.length ?? 0), 0);
    const first = mark[0]!;
    if (live.flat.originals[boundary] !== first
      || live.flat.originals[boundary - 1] !== closed.at(-1)!.snapshot.final_tokens?.at(-1)) return;
    this.frozen = { generation: live.generation, sampleRate: this.latest!.sample_rate, closed, boundary, first,
      start: closed.at(-1)!.start };
  }

  private reuse(live: Live): NativePart[] | null {
    const frozen = this.frozen;
    const page = this.latest!;
    if (!frozen || frozen.generation !== live.generation || frozen.sampleRate !== page.sample_rate
      || !this.reusable(live)) return null;
    const flat = live.flat;
    if (flat.originals[frozen.boundary] !== frozen.first) return null;
    // Chunks from the one holding the open part's first token onward.
    const chunks: ReadingChunk[] = [];
    let lastCopy: ReadingChunk | null = null;
    let found = false;
    for (let i = flat.chunks.length - 1; i >= 0 && !found; i -= 1) {
      const chunk = flat.chunks[i]!;
      const position = chunk.originals.lastIndexOf(frozen.first.id);
      if (position > 0 && chunk.atomic) return null;
      found = position >= 0;
      const copy = { originals: chunk.originals.slice(Math.max(0, position)), translations: [...chunk.translations],
        atomic: chunk.atomic };
      if (i === flat.chunks.length - 1) lastCopy = copy;
      chunks.push(copy);
    }
    if (!found) return null;
    chunks.reverse();
    const originals = flat.originals.slice(frozen.boundary);
    const ids = new Set(originals.map(token => token.id));
    const turns = new Map<string, Monologue>();
    for (const [id, turn] of flat.turns) {
      const touches = ids.has(turn.original_token_ids.at(-1) ?? '');
      turns.set(id, { ...turn, original_token_ids: touches ? suffix(turn.original_token_ids, ids) : [],
        translation_token_ids: [], passthrough_token_ids: touches ? suffix(turn.passthrough_token_ids, ids) : [],
        display_token_ids: touches ? suffix(turn.display_token_ids, ids) : [] });
    }
    const rest: Flat = { originals, translations: [], chunks, turns, unassigned: [], translated: false };
    const lastCid = this.order.at(-1)!;
    if (this.tailIncluded(lastCid)) {
      if (live.state.chunk && flat.chunks.at(-1) !== live.state.chunk) return null;
      const info = this.pages.get(lastCid)!;
      applyEvent(rest, lastCid, info.projection!.tail!, info.projection!.available,
        { status: live.state.status, chunk: live.state.chunk ? lastCopy : null }, this.ownerOf(info));
      if (rest.translated) return null;
    }
    const snapshot = this.assemble(page, rest);
    const build = buildNativeParts(snapshot);
    const unit = build.marks[0];
    if (build.irregular !== 0 || build.parts.length !== 1 || !unit?.length || unit[0] !== frozen.first) return null;
    // The full build starts a part at this unit iff it would not fit the last closed part.
    const limit = PART_SECONDS * page.sample_rate;
    const end = unit.reduce((max, token) => Math.max(max, token.end_sample), frozen.first.end_sample);
    if (!(end - frozen.start > limit && end - frozen.first.start_sample <= limit)
      && !(frozen.first.end_sample - frozen.start > limit)) return null;
    const { readingChunks: _chunks, ...top } = snapshot;
    const projection = snapshot.live_translation_projection!;
    const closed = frozen.closed.map(part => {
      const own = part.snapshot;
      const local = own.live_translation_projection!;
      return { ...part, snapshot: { ...top, final_tokens: own.final_tokens, final_translation_tokens: own.final_translation_tokens,
        live_translation_projection: { ...projection, original_tokens: local.original_tokens,
          translation_tokens: local.translation_tokens, unassigned_translation_token_ids: local.unassigned_translation_token_ids,
          monologues: local.monologues } } };
    });
    const previous = frozen.closed.at(-1)!.snapshot.final_tokens!.at(-1)!;
    const open = build.parts[0]!;
    return [...closed, { ...open, continuesPrevious: frozen.first.connection_id === previous.connection_id
      && frozen.first.speaker_number === previous.speaker_number }];
  }
}
