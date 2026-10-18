import { describe, expect, it } from 'vitest';
import { parseStudyHash, sameTarget, studyHash, validateStudyTarget } from './studyWindow';

describe('the study block window (0.3.1 S, W2)', () => {
  it('takes only backend-shaped ids: a study block st-…, a chat id of one safe segment', () => {
    expect(validateStudyTarget({ studyId: 'st-1a2b3c', chatId: 'chat-9f' })).toEqual({ studyId: 'st-1a2b3c', chatId: 'chat-9f' });
    for (const bad of [
      null, 'st-1', {}, { studyId: 'st-1' }, { studyId: 'x-1', chatId: 'c1' }, { studyId: 'st-1/../x', chatId: 'c1' },
      { studyId: 'st-1', chatId: '../c1' }, { studyId: 'st-1', chatId: 'c1#x' }, { studyId: 'st-1', chatId: 'c'.repeat(101) },
      { studyId: 'st-1', chatId: 7 }, { studyId: `st-${'a'.repeat(65)}`, chatId: 'c1' },
    ]) {
      expect(validateStudyTarget(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('round-trips through the window URL fragment, and a changed fragment is checked again', () => {
    const target = { studyId: 'st-abc', chatId: 'c12' };
    expect(parseStudyHash(`#${studyHash(target)}`)).toEqual(target);
    expect(parseStudyHash('#study=st-abc')).toBeNull();
    expect(parseStudyHash('#study=st-abc&chat=..%2Fx')).toBeNull();
    expect(parseStudyHash('')).toBeNull();
    expect(sameTarget(target, { ...target })).toBe(true);
    expect(sameTarget(target, { studyId: 'st-abc', chatId: 'c13' })).toBe(false);
    expect(sameTarget(null, target)).toBe(false);
  });
});
