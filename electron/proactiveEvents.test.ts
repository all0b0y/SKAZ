import { describe, expect, it, vi } from 'vitest';
import { ProactiveWatcher, feedUrl, type ProactiveFeed } from './proactiveEvents';

function scripted(feeds: (ProactiveFeed | Error)[]) {
  const urls: string[] = [];
  let watcher: ProactiveWatcher | null = null;
  const fetchFeed = vi.fn(async (url: string, _token: string, _signal: AbortSignal) => {
    urls.push(url);
    const next = feeds.shift();
    if (!next) { watcher?.stop(); throw new Error('done'); }
    if (next instanceof Error) throw next;
    return next;
  });
  const onChanges = vi.fn();
  const onNewCards = vi.fn();
  watcher = new ProactiveWatcher({
    handle: () => ({ port: 4000, token: 'secret' }), fetchFeed, onChanges, onNewCards, sleep: async () => {},
  });
  return { watcher, urls, onChanges, onNewCards, fetchFeed };
}

describe('proactive push feed in Electron main', () => {
  it('learns the position first, then long-polls and reacts to a new card at once', async () => {
    const run = scripted([
      { seq: 7, changes: [], sound: false },
      { seq: 9, changes: [{ session_id: 's1', new_cards: 1 }], sound: true },
      { seq: 10, changes: [{ session_id: 's1', new_cards: 0 }], sound: true },
    ]);
    await run.watcher.start();
    expect(run.urls.slice(0, 3)).toEqual([feedUrl(4000, -1), feedUrl(4000, 7), feedUrl(4000, 9)]);
    expect(run.urls[0]).toContain('timeout=0');
    expect(run.urls[1]).toContain('timeout=25');
    expect(run.onChanges.mock.calls).toEqual([[['s1']], [['s1']]]);
    // Only the change that added a card notifies; an answer filling the card does not.
    expect(run.onNewCards.mock.calls).toEqual([[true]]);
    expect(run.fetchFeed.mock.calls[0]![1]).toBe('secret');
  });

  it('never announces cards that existed before it connected', async () => {
    const run = scripted([{ seq: 3, changes: [{ session_id: 's1', new_cards: 2 }], sound: false }]);
    await run.watcher.start();
    expect(run.onNewCards).not.toHaveBeenCalled();
    expect(run.onChanges).not.toHaveBeenCalled();
  });

  it('starts over after a failure or an invalid reply instead of stopping', async () => {
    const run = scripted([
      { seq: 1, changes: [], sound: false },
      new Error('backend restarted'),
      { seq: 0, changes: 'nope' } as unknown as ProactiveFeed,
      { seq: 0, changes: [], sound: false },
      { seq: 1, changes: [{ session_id: 's2', new_cards: 1 }], sound: false },
    ]);
    await run.watcher.start();
    expect(run.urls.slice(1, 4)).toEqual([feedUrl(4000, 1), feedUrl(4000, -1), feedUrl(4000, -1)]);
    expect(run.onNewCards.mock.calls).toEqual([[false]]);
  });
});
