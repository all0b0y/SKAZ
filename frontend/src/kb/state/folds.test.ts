import { beforeEach, describe, expect, it } from 'vitest';
import { FOLDS_KEY, FOLDS_MAX, createFoldsStore } from './folds';

describe('Folded blocks in chats (U2-a): one choice per block, kept across restarts', () => {
  beforeEach(() => localStorage.clear());

  it('uses the default until the user chooses, then keeps the choice after a restart', () => {
    const store = createFoldsStore(localStorage);
    expect(store.getState().isFolded('sources:c1/m1', true)).toBe(true);
    expect(store.getState().isFolded('study:st-1', false)).toBe(false);
    store.getState().setFolded('sources:c1/m1', false);
    store.getState().setFolded('study:st-1', true);
    const again = createFoldsStore(localStorage);
    expect(again.getState().isFolded('sources:c1/m1', true)).toBe(false);
    expect(again.getState().isFolded('study:st-1', false)).toBe(true);
    expect(again.getState().isFolded('sources:c1/m2', true)).toBe(true);
  });

  it('keeps only the newest choices and ignores a broken record', () => {
    const store = createFoldsStore(localStorage);
    for (let i = 0; i < FOLDS_MAX + 5; i += 1) store.getState().setFolded(`study:${i}`, true);
    const kept = JSON.parse(localStorage.getItem(FOLDS_KEY)!) as Record<string, boolean>;
    expect(Object.keys(kept)).toHaveLength(FOLDS_MAX);
    expect(kept['study:0']).toBeUndefined();
    expect(kept[`study:${FOLDS_MAX + 4}`]).toBe(true);
    localStorage.setItem(FOLDS_KEY, '{not json');
    expect(createFoldsStore(localStorage).getState().isFolded('study:x', false)).toBe(false);
  });
});
