import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KbSearches } from '../../api/kb/types.gen';
import { exploreState, searchStatus, watchSearches } from './exploreState';
import { searchFixture } from './test/fixtures';

const list = (...items: ReturnType<typeof searchFixture>[]): KbSearches => ({ items, parallel_limit: 3 });

/** A read the test finishes by hand, so it can decide when each answer arrives. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const newStore = (read: () => Promise<KbSearches> = async () => list()) => exploreState({}, read);

describe('EX3 explore state — what the page and the side list share', () => {
  it('gives one store per library, so the side list and the page read the same state', () => {
    const key = {};
    const read = async () => list();
    expect(exploreState(key, read)).toBe(exploreState(key, read));
    expect(exploreState({}, read)).not.toBe(exploreState(key, read));
  });

  it('starts on the map at the top level with nothing picked', () => {
    const s = newStore().getState();
    expect(s).toMatchObject({ page: { kind: 'map' }, level: null, selected: null, multi: [], searches: [], parallelLimit: 3, searchesFailed: false, covers: 0 });
  });

  it('opens a search page and clears the picked tiles; showMap comes back', () => {
    const store = newStore();
    store.getState().toggleMulti('a'); store.getState().toggleMulti('b');
    expect(store.getState().multi).toEqual(['a', 'b']);
    store.getState().showSearch('run-1');
    expect(store.getState()).toMatchObject({ page: { kind: 'search', id: 'run-1' }, multi: [] });
    store.getState().showMap();
    expect(store.getState().page).toEqual({ kind: 'map' });
  });

  it('goToLevel moves the map, selects that topic by default, and clears the picked tiles', () => {
    const store = newStore();
    store.getState().toggleMulti('a'); store.getState().toggleMulti('b');
    store.getState().goToLevel('ai');
    expect(store.getState()).toMatchObject({ level: 'ai', selected: 'ai', multi: [] });
    store.getState().goToLevel('ai', null);
    expect(store.getState()).toMatchObject({ level: 'ai', selected: null });
    store.getState().goToLevel(null);
    expect(store.getState()).toMatchObject({ level: null, selected: null });
  });
});

describe('EX3 explore state — ⌘-picking tiles (toggleMulti, UX-12)', () => {
  it('the first ⌘-click only selects the tile; the second makes it a pick of two', () => {
    const store = newStore();
    store.getState().toggleMulti('ml');
    expect(store.getState()).toMatchObject({ selected: 'ml', multi: [] });
    store.getState().toggleMulti('ai');
    expect(store.getState().multi).toEqual(['ml', 'ai']);
  });

  it('starts from the selected tile: it is the first of the pick', () => {
    const store = newStore();
    store.getState().goToLevel('biz');
    store.getState().toggleMulti('ml');
    expect(store.getState().multi).toEqual(['biz', 'ml']);
    store.getState().toggleMulti('ai');
    expect(store.getState().multi).toEqual(['biz', 'ml', 'ai']);
  });

  it('⌘-clicking a picked tile takes it out; one left becomes the plain selection', () => {
    const store = newStore();
    ['a', 'b', 'c'].forEach((id) => store.getState().toggleMulti(id));
    expect(store.getState().multi).toEqual(['a', 'b', 'c']);
    store.getState().toggleMulti('b');
    expect(store.getState().multi).toEqual(['a', 'c']);
    store.getState().toggleMulti('a');
    expect(store.getState()).toMatchObject({ multi: [], selected: 'c' });
  });

  it('clearMulti drops the pick and keeps the selected topic', () => {
    const store = newStore();
    ['a', 'b'].forEach((id) => store.getState().toggleMulti(id));
    store.getState().clearMulti();
    expect(store.getState().multi).toEqual([]);
  });
});

describe('EX3 explore state — reading the searches', () => {
  it('keeps the list and the parallel limit it read', async () => {
    const store = newStore(async () => ({ items: [searchFixture('run-1', 'A')], parallel_limit: 2 }));
    await store.getState().refresh();
    expect(store.getState().searches.map((s) => s.id)).toEqual(['run-1']);
    expect(store.getState().parallelLimit).toBe(2);
  });

  it('falls back to the map when the search on the page is gone from the list', async () => {
    let items = [searchFixture('run-1', 'A'), searchFixture('run-2', 'B')];
    const store = newStore(async () => list(...items));
    await store.getState().refresh();
    store.getState().showSearch('run-2');
    await store.getState().refresh();
    expect(store.getState().page).toEqual({ kind: 'search', id: 'run-2' });
    items = [items[0]!];
    await store.getState().refresh();
    expect(store.getState().page).toEqual({ kind: 'map' });
    expect(store.getState().searches.map((s) => s.id)).toEqual(['run-1']);
  });

  it('does not move a map page, and leaves the page alone while a read fails', async () => {
    let fail = false;
    const store = newStore(async () => { if (fail) throw new Error('offline'); return list(searchFixture('run-1', 'A')); });
    await store.getState().refresh();
    store.getState().showSearch('run-1');
    fail = true;
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({ searchesFailed: true, page: { kind: 'search', id: 'run-1' } });
    expect(store.getState().searches).toHaveLength(1);
    fail = false;
    await store.getState().refresh();
    expect(store.getState().searchesFailed).toBe(false);
  });

  it('answers two calls made together with one read', async () => {
    const read = vi.fn(async () => list());
    const store = newStore(read);
    await Promise.all([store.getState().refresh(), store.getState().refresh().then(() => undefined)]);
    // the second call asked while the first read ran: one more read follows, never more than that
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
    await store.getState().refresh();
    expect(read.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('reads again after a read already in flight, so a change made meanwhile is not missed', async () => {
    const first = deferred<KbSearches>();
    const reads = [first.promise, Promise.resolve(list(searchFixture('run-1', 'Old'), searchFixture('run-new', 'Just started')))];
    const read = vi.fn(() => reads.shift()!);
    const store = newStore(read);
    const early = store.getState().refresh();              // began before the search was started
    const afterStart = store.getState().refresh();         // asked after it was: must see it
    first.resolve(list(searchFixture('run-1', 'Old')));
    await early;
    await afterStart;
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.getState().searches.map((s) => s.id)).toEqual(['run-1', 'run-new']);
  });
});

describe('EX3 explore state — covers (the paper view steps aside)', () => {
  it('counts the overlays that are up, and each one is released once', () => {
    const store = newStore();
    const releaseMenu = store.getState().cover();
    const releaseDialog = store.getState().cover();
    expect(store.getState().covers).toBe(2);
    releaseMenu();
    releaseMenu();
    expect(store.getState().covers).toBe(1);
    releaseDialog();
    expect(store.getState().covers).toBe(0);
  });
});

describe('EX3 explore state — watching the searches while someone shows them', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads once on the first watcher, and again every 1.5 s only while a search runs or waits', async () => {
    let items = [searchFixture('run-1', 'A', { state: 'running' })];
    const read = vi.fn(async () => list(...items));
    const store = newStore(read);
    const stop = watchSearches(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(3);
    items = [searchFixture('run-1', 'A', { state: 'done' })];
    await vi.advanceTimersByTimeAsync(1500);      // reads the finished state…
    const settled = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);      // …and then stops asking
    expect(read.mock.calls.length).toBe(settled);
    stop();
  });

  it('polls a queued search too, and one timer serves the side list and the page together', async () => {
    const read = vi.fn(async () => list(searchFixture('run-1', 'A', { state: 'queued' })));
    const store = newStore(read);
    const stopSide = watchSearches(store);
    const stopPage = watchSearches(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);       // the first watcher reads; the second adds no read
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(2);       // one timer, not two
    stopSide();
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(3);       // the page still watches
    stopPage();
    await vi.advanceTimersByTimeAsync(9000);
    expect(read).toHaveBeenCalledTimes(3);       // nobody watches: nothing is read
  });

  it('reads again at once when someone starts watching after everyone stopped', async () => {
    const read = vi.fn(async () => list());
    const store = newStore(read);
    watchSearches(store)();
    await vi.advanceTimersByTimeAsync(0);
    watchSearches(store)();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('EX3 explore state — the status a search shows in the side list', () => {
  const s = (extra: Partial<ReturnType<typeof searchFixture>>) => searchStatus(searchFixture('run-1', 'A', extra));

  it('says how far a running search has come', () => {
    expect(s({ state: 'running', found: 12 })).toEqual({ text: '12 found…', tone: 'run' });
    expect(s({ state: 'running', found: 0 })).toEqual({ text: 'Searching…', tone: 'run' });
  });

  it('says a search waits for a free place, is paused, or failed', () => {
    expect(s({ state: 'queued' })).toEqual({ text: 'Waiting', tone: 'quiet' });
    expect(s({ state: 'paused' })).toEqual({ text: 'Paused', tone: 'stop' });
    expect(s({ state: 'error' })).toEqual({ text: 'Failed', tone: 'stop' });
  });

  it('shows +N for what you have not seen, and 0 new when everything is seen', () => {
    expect(s({ state: 'done', unseen: 47 })).toEqual({ text: '+47', tone: 'new' });
    expect(s({ state: 'done', unseen: 0 })).toEqual({ text: '0 new', tone: 'quiet' });
  });

  it('shows a stopped search as Stopped', () => {
    expect(s({ state: 'cancelled', unseen: 0 })).toEqual({ text: 'Stopped', tone: 'quiet' });
  });
});
