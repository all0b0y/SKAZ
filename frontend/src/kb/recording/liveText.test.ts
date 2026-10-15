import { describe, expect, it } from 'vitest';
import type { KbFragment, KbRecordingLive } from '../../api/kb/types.gen';
import { lastSeg, liveAfter } from './liveText';

const answer = (after_seg: number, texts: string[], partial: string | null = 'still'): KbRecordingLive => ({
  material_id: 'm1', after_seg, stream: 'streaming',
  monologues: texts.map((text, i) => ({ speaker: '1', start_ms: i * 1000, end_ms: i * 1000 + 900, text })),
  partial: partial === null ? null : { speaker: '1', text: partial, translation: '' },
});

describe('Live text after the material (G1)', () => {
  it('the last fragment is the highest seg', () => {
    expect(lastSeg([])).toBe(0);
    expect(lastSeg([{ seg: 1 }, { seg: 3 }, { seg: 2 }] as KbFragment[])).toBe(3);
  });

  it('fits a material at the same step as is: open monologue and grey words', () => {
    expect(liveAfter(answer(2, ['we keep talking']), 2)).toEqual({
      monologues: [expect.objectContaining({ text: 'we keep talking' })], partial: { speaker: '1', text: 'still', translation: '' },
    });
  });

  it('a newer material already holds the monologues that closed: they and the grey words are left out', () => {
    expect(liveAfter(answer(2, ['closed one', 'open one']), 3)).toEqual({
      monologues: [expect.objectContaining({ text: 'open one' })], partial: null,
    });
    expect(liveAfter(answer(2, ['closed one']), 4)).toEqual({ monologues: [], partial: null });
  });

  it('an older material is behind the answer: the caller keeps its previous text and reloads', () => {
    expect(liveAfter(answer(3, ['next']), 2)).toBe('material-behind');
  });
});
