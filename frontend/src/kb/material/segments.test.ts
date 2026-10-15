import { describe, expect, it } from 'vitest';
import type { KbCorrection, KbFragment } from '../api/b2-u3';
import { markQuote, readableBlockText, relativeTime } from '../document/text';
import { byPage, monologues, segmentText, translationBySeg } from './segments';

const fix = (over: Partial<KbCorrection>): KbCorrection => ({
  id: 'c', material_id: 'm', seg: 1, before: 'a', after: 'b', reason: '', confidence: null, state: 'applied', auto: true,
  created_at: '', decided_at: null, ...over,
});
const frag = (seg: number, over: Partial<KbFragment> = {}): KbFragment => ({
  id: `f${seg}`, seg, text: `t${seg}`, start_ms: null, end_ms: null, speaker: null, page: null, index: null,
  original_text: null, corrections: [], ...over,
});

describe('Block text and quotes', () => {
  it('drops citation wikilinks (shown as chips) and keeps what a reader sees of other links', () => {
    expect(readableBlockText('S = k ln W [[Materials/Physics/L8/L8#^seg-1|L8 · 08:12]] and [[Wiki/Concepts/Entropy|entropy]] [[Wiki/Concepts/Logarithm]] ^c-ab12'))
      .toBe('S = k ln W and entropy Logarithm');
  });

  it('marks the exact quote, tolerant to case and whitespace; no match leaves the text unmarked', () => {
    expect(markQuote('So Boltzmann wrote S equals k', 'boltzmann  wrote')).toEqual([
      { text: 'So ', mark: false }, { text: 'Boltzmann wrote', mark: true }, { text: ' S equals k', mark: false },
    ]);
    expect(markQuote('Line one\nline two', 'one line')).toEqual([
      { text: 'Line ', mark: false }, { text: 'one\nline', mark: true }, { text: ' two', mark: false },
    ]);
    expect(markQuote('Nothing here', 'absent')).toEqual([{ text: 'Nothing here', mark: false }]);
  });

  it('says honest coarse times', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(relativeTime('2026-10-15T10:00:00Z', now)).toBe('2 h ago');
    expect(relativeTime('2026-10-14T11:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('nope', now)).toBe('');
  });
});

describe('Fragment pieces: recognition fixes and the target quote', () => {
  it('underlines an applied fix at its new words and a doubtful one at the recognised words', () => {
    const pieces = segmentText('the micro states of Shannon', null, [
      fix({ id: 'c1', state: 'doubtful', before: 'micro states', after: 'microstates' }),
      fix({ id: 'c2', state: 'applied', before: 'Shanon', after: 'Shannon' }),
      fix({ id: 'c3', state: 'kept', before: 'the', after: 'a' }),
    ]);
    expect(pieces.map((p) => [p.text, p.fix?.id ?? null])).toEqual([
      ['the ', null], ['micro states', 'c1'], [' of ', null], ['Shannon', 'c2'],
    ]);
  });

  it('overlays the quote and the fixes without losing text', () => {
    const text = 'it is the same entropy just for messages';
    const pieces = segmentText(text, 'same entropy just', [fix({ id: 'c', before: 'entropi', after: 'entropy' })]);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
    expect(pieces.filter((p) => p.quote).map((p) => p.text).join('')).toBe('same entropy just');
    expect(pieces.find((p) => p.fix)?.text).toBe('entropy');
    expect(pieces.find((p) => p.fix)?.quote).toBe(true);
  });

  it('groups monologues by speaker, PDF fragments by page, translation by segment when it has ids', () => {
    expect(monologues([frag(1, { speaker: 'Speaker 1' }), frag(2, { speaker: 'Speaker 1' }), frag(3, { speaker: 'Speaker 2' })])
      .map((m) => [m.speaker, m.fragments.length])).toEqual([['Speaker 1', 2], ['Speaker 2', 1]]);
    expect(byPage([frag(1, { page: 30 }), frag(2, { page: 31 }), frag(3, { page: 31 })]).map((p) => [p.page, p.fragments.length]))
      .toEqual([[30, 1], [31, 2]]);
    expect(translationBySeg({ language: 'ru', fragments: [{ seg: 1, text: 'a' }, { seg: 1, text: 'b' }] })?.get(1)).toBe('a b');
    // Soniox: no segment ids → paragraphs, not a map.
    expect(translationBySeg({ language: 'ru', fragments: [{ seg: null, text: 'a' }] })).toBeNull();
    expect(translationBySeg(null)).toBeNull();
  });
});
