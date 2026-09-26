import { expect, it } from 'vitest';
import type { NativeTranscriptToken } from '../../api/nativeLive';
import { nativeParts, type ReadingSnapshot } from './nativeParts';

function snapshot(tokens: NativeTranscriptToken[], translated = false): ReadingSnapshot {
  const translation = { id: 't', connection_id: 'c', speaker_number: 1, text: 'Whole translation.' };
  return { session_id: 's', sample_rate: 1, saved_samples: tokens.at(-1)?.end_sample ?? 0,
    next_sequence: 0, recording_mode: translated ? 'translation' : 'transcription', transcription: 'inactive',
    connections: [], gaps: [], final_tokens: tokens,
    ...(translated ? { readingChunks: [{ originals: tokens.map(t => t.id), translations: ['t'], atomic: true }],
      live_translation_projection: { original_tokens: tokens, translation_tokens: [translation],
        order_unavailable_connection_ids: [], unassigned_translation_token_ids: [], monologues: [{
          id: 'turn', connection_id: 'c', speaker_number: 1, start_sample: 0,
          original_token_ids: tokens.map(t => t.id), translation_token_ids: ['t'],
          passthrough_token_ids: [], display_token_ids: ['t'],
        }] } } : {}) };
}
function words(count: number, seconds = 60, punctuated = true): NativeTranscriptToken[] {
  return Array.from({ length: count }, (_, i) => ({ id: `o${i}`, segment_id: `s${i}`, connection_id: 'c',
    speaker_number: 1, start_sample: i * seconds, end_sample: (i + 1) * seconds,
    text: `Word ${i}${punctuated ? '.' : ''} ` }));
}

it('retains every source exactly once and caps each reading part at thirty minutes', () => {
  const tokens = words(75);
  const parts = nativeParts(snapshot(tokens));
  expect(parts).toHaveLength(3);
  expect(parts.every(part => part.end - part.start <= 1800)).toBe(true);
  expect(parts.flatMap(part => part.snapshot.final_tokens)).toEqual(tokens);
  expect(parts.map(part => part.continuesPrevious)).toEqual([false, true, true]);
});

it('moves the next complete sentence before the limit, leaving the prior part shorter', () => {
  const tokens = words(31);
  tokens[28]!.text = 'Beginning ';
  tokens[29]!.text = 'of a sentence ';
  const parts = nativeParts(snapshot(tokens));
  expect(parts.map(part => [part.start, part.end])).toEqual([[0, 1680], [1680, 1860]]);
  expect(parts[1]!.snapshot.final_tokens?.map(token => token.id)).toEqual(['o28', 'o29', 'o30']);
});

it('cuts an oversized unpunctuated utterance without rewriting source identity or timing', () => {
  const tokens = words(75, 60, false);
  const parts = nativeParts(snapshot(tokens));
  expect(parts).toHaveLength(3);
  expect(parts.every(part => part.end - part.start <= 1800)).toBe(true);
  expect(parts.flatMap(part => part.snapshot.final_tokens)).toEqual(tokens);
});

it('keeps an oversized indivisible translation at the beginning and links continuation parts back', () => {
  const original = snapshot(words(75, 60, false), true);
  const parts = nativeParts(original);
  expect(parts.map(part => part.snapshot.final_translation_tokens?.map(t => t.id))).toEqual([['t'], [], []]);
  expect(parts.map(part => part.translationStartPart)).toEqual([null, 0, 0]);
  expect(parts[1]!.snapshot.live_translation_projection?.monologues[0]).toMatchObject({
    id: 'turn', speaker_number: 1, start_sample: 1800, translation_token_ids: [],
  });
  expect(parts.flatMap(part => part.snapshot.final_tokens)).toEqual(original.final_tokens);
});

it('moves a fitting original/translation group together rather than cutting or guessing alignment', () => {
  const original = snapshot(words(35), true);
  original.readingChunks = [
    { originals: words(25).map(t => t.id), translations: [], atomic: false },
    { originals: words(35).slice(25).map(t => t.id), translations: ['t'], atomic: true },
  ];
  const parts = nativeParts(original);
  expect(parts.map(part => [part.start, part.end])).toEqual([[0, 1500], [1500, 2100]]);
  expect(parts.map(part => part.snapshot.final_translation_tokens?.length)).toEqual([0, 1]);
});

it('keeps a late translation on the original part without duplicating old speaker turns', () => {
  const original = snapshot(words(40), true);
  original.readingChunks = original.final_tokens!.map(token => ({ originals: [token.id],
    translations: token.id === 'o0' ? ['t'] : [], atomic: true }));
  const parts = nativeParts(original);
  expect(parts.map(part => part.snapshot.final_translation_tokens?.length)).toEqual([1, 0]);
  expect(parts[1]!.snapshot.live_translation_projection?.monologues).toHaveLength(1);
  expect(parts[1]!.snapshot.live_translation_projection?.monologues[0]?.original_token_ids).not.toContain('o0');
});

it('does not merge speakers across reconnects or lose an empty transcript', () => {
  const tokens = words(31);
  tokens[30]!.connection_id = 'new-connection';
  expect(nativeParts(snapshot(tokens))[1]!.continuesPrevious).toBe(false);
  expect(nativeParts(snapshot([]))).toHaveLength(1);
});

// A live recording holds one long monologue per speaker. Splitting it per part
// re-scanned every id list once per part, so each 1 s poll cost grew with
// parts × history. Each list must be walked a bounded number of times.
it('walks a long monologue\'s id lists a bounded number of times however many parts there are', () => {
  const tokens = words(150); // 150 min at sample_rate 1 → five 30-minute parts
  const ids = tokens.map(t => t.id);
  let reads = 0;
  const counted = (list: string[]) => new Proxy(list, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
    return Reflect.get(target, key, receiver);
  } });
  const source: ReadingSnapshot = { ...snapshot(tokens), live_translation_projection: {
    original_tokens: tokens, translation_tokens: [], order_unavailable_connection_ids: [],
    unassigned_translation_token_ids: [], monologues: [{ id: 'turn', connection_id: 'c', speaker_number: 1,
      start_sample: 0, original_token_ids: counted(ids), translation_token_ids: counted([]),
      passthrough_token_ids: counted([...ids]), display_token_ids: counted([...ids]) }] } };
  const parts = nativeParts(source);
  expect(parts).toHaveLength(5);
  // Three non-empty lists of N ids: a constant number of passes, not one per part.
  expect(reads).toBeLessThanOrEqual(6 * ids.length);
  expect(parts.flatMap(part => part.snapshot.live_translation_projection!.monologues[0]!.original_token_ids)).toEqual(ids);
  expect(parts.map(part => part.snapshot.live_translation_projection!.monologues[0]!.start_sample))
    .toEqual([0, 1800, 3600, 5400, 7200]);
});
