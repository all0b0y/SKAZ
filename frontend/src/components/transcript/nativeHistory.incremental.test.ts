import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeEventPage, NativeTranslationStatus, NativeTurnOwner } from '../../api/nativeEventPages';
import type { NativeTranscriptToken, NativeTranslationToken } from '../../api/nativeLive';
import { NativeHistory } from './nativeHistory';
import { nativeParts } from './nativeParts';
import { ReferenceHistory, referenceParts, withoutChunks } from '../../test/nativeReference';

// Synthetic event pages with the shapes the backend returns. They check that
// the incremental history/parts equal a from-scratch computation after every
// merge; real speech and ASR are not involved.
type Event = NativeEventPage['events'][number];
type Mode = 'transcription' | 'translation';

function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

class Recording {
  events = new Map<string, Event[]>();
  connections: string[] = [];
  groups: Record<string, NativeTurnOwner | null> = {};
  tailGroups: Record<string, NativeTurnOwner | null> = {};
  available = new Map<string, boolean>();
  private clock = 0;
  private speaker = 1;
  private owner: NativeTurnOwner | null = null;
  constructor(private readonly next: () => number, readonly mode: Mode, private readonly oversized = true) { this.connect(); }

  connect() {
    const cid = `c${this.connections.length}`;
    this.connections.push(cid); this.events.set(cid, []); this.owner = null;
    this.available.set(cid, this.next() > 0.1);
    this.tailGroups = {};
  }
  get cid() { return this.connections.at(-1)!; }

  private tokens(cid: string, prefix: string, count: number): NativeTranscriptToken[] {
    return Array.from({ length: count }, (_, i) => {
      if (this.next() < 0.08) this.speaker = this.speaker === 1 ? 2 : 1;
      const start = this.clock; this.clock += 2 + Math.floor(this.next() * 14);
      const end = this.oversized && this.next() < 0.03 ? start + 1900 : this.clock; // occasional oversized token
      return { id: `${prefix}:${i}`, connection_id: cid, segment_id: prefix.includes('tail') ? null : `${prefix}:s`,
        speaker_number: this.speaker, start_sample: start, end_sample: end,
        text: `w${i}${this.next() < 0.25 ? '.' : ''} ` };
    });
  }

  /** One event (or a tail) with owners, translation groups and stream order. */
  private event(cid: string, id: string, ordinal: number | undefined): Omit<Event, 'segment_ids' | 'originals_available'> {
    const originals = this.tokens(cid, id, 1 + Math.floor(this.next() * 3));
    const owners: Record<string, NativeTurnOwner> = {};
    for (const token of originals) {
      if (!this.owner || this.owner.speaker_number !== token.speaker_number) {
        this.owner = { id: token.id, connection_id: cid, speaker_number: token.speaker_number, start_sample: token.start_sample };
      }
      owners[token.id] = this.owner;
    }
    const translations: NativeTranslationToken[] = [];
    const references: Record<string, string> = {};
    const order: Array<{ id: string; translation_status: NativeTranslationStatus }> = [];
    if (this.mode === 'transcription') {
      for (const token of originals) order.push({ id: token.id, translation_status: 'none' });
    } else {
      for (const token of originals) order.push({ id: token.id, translation_status: this.next() < 0.2 ? 'none' : 'original' });
      const count = Math.floor(this.next() * 3);
      for (let i = 0; i < count; i += 1) {
        const tid = `${id}:t${i}`;
        translations.push({ id: tid, connection_id: cid, speaker_number: this.speaker, text: `t${i} ` });
        const group = `${cid}:g${Math.floor((ordinal ?? this.clock) / 3)}`;
        references[tid] = group;
        if (ordinal !== undefined && !(group in this.groups)) this.groups[group] = this.next() < 0.1 ? null : this.owner;
        order.push({ id: tid, translation_status: 'translation' });
      }
    }
    return { ordinal: ordinal as number, originals, translations, order,
      projection: { owners, translations: references, passthrough: [] } };
  }

  add(count: number) {
    const cid = this.cid; const list = this.events.get(cid)!;
    for (let i = 0; i < count; i += 1) {
      const ordinal = list.length;
      list.push({ ...this.event(cid, `${cid}:${ordinal}`, ordinal), segment_ids: [], originals_available: true } as Event);
    }
  }

  tail(): NonNullable<NonNullable<NativeEventPage['projection']>['tail']> | null {
    if (this.next() < 0.3) return null;
    const saved = { clock: this.clock, speaker: this.speaker, owner: this.owner };
    const tail = this.event(this.cid, `${this.cid}:tail:original`, undefined);
    // A tail is replaced by the next poll; it never advances durable state.
    this.clock = saved.clock; this.speaker = saved.speaker; this.owner = saved.owner;
    return { originals: tail.originals, translations: tail.translations, order: tail.order!, projection: tail.projection! };
  }

  page(cid: string, from: number, to: number, tail: ReturnType<Recording['tail']>): NativeEventPage {
    const list = this.events.get(cid)!;
    const events = list.slice(from, to + 1);
    const index = this.connections.indexOf(cid);
    const through = list.length - 1;
    return { protocol: 1, session_id: 's', sample_rate: 1, saved_samples: this.clock,
      recording_mode: this.mode, translation_target_language: 'ru', transcription: 'streaming',
      connection: { id: cid, start_sample: 0, end_sample: null, status: 'active', final_sample: 0, processed_sample: 0 },
      through, events, next_after: events.at(-1)?.ordinal ?? from - 1, next_before: events[0]?.ordinal ?? from,
      has_newer: to < through, has_older: from > 0,
      previous_connection_id: this.connections[index - 1] ?? null, next_connection_id: this.connections[index + 1] ?? null,
      tail: null,
      projection: { available: this.available.get(cid)!, tail_groups: { ...this.tailGroups }, tail,
        groups: { ...this.groups } },
    };
  }
}

const json = (value: unknown) => JSON.stringify(value);

/** Equivalence after every merge against the pre-rewrite implementation (test oracle). */
function check(history: NativeHistory, reference: ReferenceHistory) {
  const expected = reference.snapshot();
  expect(json(history.snapshot())).toBe(json(expected));
  expect(json(history.parts())).toBe(json(expected ? withoutChunks(referenceParts(expected)) : []));
  expect(history.revision).toBe(reference.revision);
}

/** Counts reads served from reused closed parts, so the tests prove they cover that path. */
function countReuse() {
  const reuse = vi.spyOn(NativeHistory.prototype as unknown as { reuse: (...args: unknown[]) => unknown }, 'reuse');
  return () => reuse.mock.results.filter(result => result.value !== null).length;
}

describe('incremental native history', () => {
  afterEach(() => vi.restoreAllMocks());
  // `oversized` streams contain single tokens longer than a part: the open part
  // then begins mid-unit, which must fall back to the full build. Realistic
  // streams (no such tokens) must actually be served from reused closed parts.
  const cases = [
    ...(['transcription', 'translation'] as const).map(mode => ({ mode, oversized: true })),
    { mode: 'transcription' as const, oversized: false },
  ];
  for (const { mode, oversized } of cases) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      it(`equals a full rebuild after every merge (${mode}${oversized ? ', oversized tokens' : ''}, seed ${seed})`, () => {
        const next = random(seed * 7919 + (mode === 'translation' ? 1 : 0));
        const recording = new Recording(next, mode, oversized);
        const reused = countReuse();
        const history = new NativeHistory();
        const reference = new ReferenceHistory();
        const merge = (page: NativeEventPage, direction: 'older' | 'newer') => {
          history.merge(page, direction); reference.merge(page, direction); check(history, reference);
        };
        // Opening a session: the latest page first, then history backwards.
        recording.add(40);
        merge(recording.page(recording.cid, 25, 39, recording.tail()), 'newer');
        merge(recording.page(recording.cid, 10, 24, null), 'older');
        merge(recording.page(recording.cid, 0, 9, null), 'older');
        let known = 39;
        for (let tick = 0; tick < 260; tick += 1) {
          const roll = next();
          if (roll < 0.02) { recording.connect(); known = -1; }
          else if (roll < 0.05 && Object.keys(recording.groups).length) {
            const keys = Object.keys(recording.groups);
            recording.groups[keys[Math.floor(next() * keys.length)]!] = null; // ownership revised
          } else if (roll < 0.08 && Object.keys(recording.groups).length) {
            const keys = Object.keys(recording.groups);
            recording.tailGroups = { [keys.at(-1)!]: next() < 0.5 ? null : recording.groups[keys.at(-1)!]! };
          }
          recording.add(Math.floor(next() * 8));
          const through = recording.events.get(recording.cid)!.length - 1;
          merge(recording.page(recording.cid, known + 1, through, recording.tail()), 'newer');
          known = through;
        }
        // Realistic transcription streams must actually exercise reuse; translation never reuses.
        // Reuse legitimately stops after a reconnect that leaves a stale tail on
        // an earlier connection, so the floor is modest (observed 14–113 per seed).
        if (mode === 'translation') expect(reused()).toBe(0);
        else if (!oversized) expect(reused()).toBeGreaterThan(10);
        // ~2 s alone: every merge is checked against a full reference rebuild, which
        // exceeds the 5 s default when the whole suite runs in parallel.
      }, 30_000);
    }
  }

  it('reuses closed thirty-minute parts instead of rebuilding them on each poll', () => {
    const recording = new Recording(random(99), 'transcription', false);
    const history = new NativeHistory();
    recording.add(400);
    history.merge(recording.page(recording.cid, 0, 399, null), 'newer');
    const before = history.parts();
    expect(before.length).toBeGreaterThan(2);
    let known = 399;
    for (let tick = 0; tick < 5; tick += 1) {
      recording.add(3);
      history.merge(recording.page(recording.cid, known + 1, known + 3, recording.tail()), 'newer');
      known += 3;
      const after = history.parts();
      // A closed part keeps its computed token list: nothing re-derived it.
      expect(after[0]!.snapshot.final_tokens).toBe(before[0]!.snapshot.final_tokens);
      expect(json(after)).toBe(json(nativeParts(history.snapshot()!)));
    }
  });
});
