import { describe, expect, it } from 'vitest';
import { adjacentSelection, createChatTabsStore } from './tabsStore';
import type { ReadingAnchor } from './readingAnchor';

const anchor = (scrollTop: number, messageId: string | null = null): ReadingAnchor => ({
  messageId,
  offsetPx: 0,
  scrollTop,
  stickToBottom: false,
  updatedAt: 1000,
});

describe('adjacentSelection', () => {
  it('picks right neighbour first, then left, then null', () => {
    expect(adjacentSelection(['a', 'b', 'c'], 'a')).toEqual({ nextActiveId: 'b', focusId: 'b', index: 0 });
    expect(adjacentSelection(['a', 'b', 'c'], 'b')).toEqual({ nextActiveId: 'c', focusId: 'c', index: 1 });
    expect(adjacentSelection(['a', 'b', 'c'], 'c')).toEqual({ nextActiveId: 'b', focusId: 'b', index: 2 });
    expect(adjacentSelection(['a'], 'a')).toEqual({ nextActiveId: null, focusId: null, index: 0 });
    expect(adjacentSelection(['a'], 'missing')).toEqual({ nextActiveId: null, focusId: null, index: -1 });
  });
});

describe('createChatTabsStore', () => {
  it('opens and selects tabs keyed by chat ID without duplicating open tabs', () => {
    const store = createChatTabsStore();
    store.getState().open('c1');
    store.getState().open('c2');
    store.getState().open('c1');

    expect(store.getState().openIds).toEqual(['c1', 'c2']);
    expect(store.getState().activeId).toBe('c1');
    expect(store.getState().allClosed).toBe(false);

    expect(store.getState().select('c2')).toBe(true);
    expect(store.getState().activeId).toBe('c2');
    expect(store.getState().select('c999')).toBe(false);
    expect(store.getState().activeId).toBe('c2');
  });

  it('closes an inactive tab without switching away from the active tab', () => {
    const store = createChatTabsStore({ openIds: ['c1', 'c2', 'c3'], activeId: 'c2' });
    store.getState().setAnchor('c1', anchor(240, 'm4'));

    const res = store.getState().close('c1');
    expect(res).toEqual({ closed: true, wasActive: false, nextActiveId: 'c2', focusId: 'c2' });
    expect(store.getState().openIds).toEqual(['c2', 'c3']);
    expect(store.getState().activeId).toBe('c2');
    expect(store.getState().lastClosedId).toBe('c1');
    expect(store.getState().allClosed).toBe(false);
    expect(store.getState().getAnchor('c1')?.scrollTop).toBe(240);
  });

  it('closes the active tab selecting right neighbour then left, then allClosed on last close', () => {
    const store = createChatTabsStore({ openIds: ['c1', 'c2', 'c3'], activeId: 'c2' });

    expect(store.getState().close('c2')).toEqual({
      closed: true,
      wasActive: true,
      nextActiveId: 'c3',
      focusId: 'c3',
    });
    expect(store.getState().activeId).toBe('c3');

    expect(store.getState().close('c3')).toEqual({
      closed: true,
      wasActive: true,
      nextActiveId: 'c1',
      focusId: 'c1',
    });
    expect(store.getState().activeId).toBe('c1');

    expect(store.getState().close('c1')).toEqual({
      closed: true,
      wasActive: true,
      nextActiveId: null,
      focusId: null,
    });
    expect(store.getState().openIds).toEqual([]);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState().allClosed).toBe(true);
    expect(store.getState().lastClosedId).toBe('c1');
  });

  it('reopens the last closed chat with its preserved reading anchor', () => {
    const store = createChatTabsStore({ openIds: ['c1', 'c2'], activeId: 'c1' });
    store.getState().setAnchor('c1', anchor(310, 'm7'));
    store.getState().close('c1');
    store.getState().close('c2');
    expect(store.getState().allClosed).toBe(true);
    expect(store.getState().lastClosedId).toBe('c2');

    expect(store.getState().reopenLast()).toBe('c2');
    expect(store.getState().openIds).toEqual(['c2']);
    expect(store.getState().activeId).toBe('c2');
    expect(store.getState().allClosed).toBe(false);
    expect(store.getState().lastClosedId).toBe('c1');

    expect(store.getState().reopenLast()).toBe('c1');
    expect(store.getState().getAnchor('c1')).toMatchObject({ scrollTop: 310, messageId: 'm7' });
    expect(store.getState().reopenLast()).toBeNull();
  });

  it('keeps open tabs intact when switching to New chat and stays in New chat if a background tab closes', () => {
    const store = createChatTabsStore({ openIds: ['c1', 'c2'], activeId: 'c1' });
    store.getState().openNewChat();

    expect(store.getState().activeId).toBeNull();
    expect(store.getState().allClosed).toBe(false);
    expect(store.getState().openIds).toEqual(['c1', 'c2']);

    store.getState().close('c1');
    store.getState().close('c2');
    expect(store.getState().openIds).toEqual([]);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState().allClosed).toBe(false);
  });

  it('cleans up tabs, closed history and reading anchors only on permanent forget()', () => {
    const store = createChatTabsStore({ openIds: ['c1', 'c2'], activeId: 'c1' });
    store.getState().setAnchor('c1', anchor(120, 'm2'));
    store.getState().setAnchor('c2', anchor(480, 'm9'));
    store.getState().close('c1');

    expect(store.getState().lastClosedId).toBe('c1');
    expect(store.getState().getAnchor('c1')).toBeDefined();

    store.getState().forget('c1');
    expect(store.getState().lastClosedId).toBeNull();
    expect(store.getState().getAnchor('c1')).toBeUndefined();

    const res = store.getState().forget('c2');
    expect(res).toEqual({ closed: true, wasActive: true, nextActiveId: null, focusId: null });
    expect(store.getState().openIds).toEqual([]);
    expect(store.getState().getAnchor('c2')).toBeUndefined();
    expect(store.getState().lastClosedId).toBeNull();
  });
});
