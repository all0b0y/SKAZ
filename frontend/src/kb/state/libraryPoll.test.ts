import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KbLibrary } from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';
import { createLibraryStore, INDEXING_POLL_MS } from './library';

afterEach(() => { vi.useRealTimers(); });

describe('Following a library scan (L4)', () => {
  it('a backend that is down is asked less and less often, not every 1.5 s forever', async () => {
    vi.useFakeTimers();
    const indexing = { state: 'ready', indexing: true } as unknown as KbLibrary;
    const calls: number[] = [];
    let first = true;
    const client = {
      library: vi.fn(async () => {
        if (first) { first = false; return indexing; }
        calls.push(Date.now());
        throw new Error('offline');
      }),
      call: vi.fn(async () => []),
    } as unknown as KbClient;
    const store = createLibraryStore(client);
    await store.getState().loadLibrary();
    await vi.advanceTimersByTimeAsync(60_000);
    const gaps = calls.slice(1).map((at, i) => at - calls[i]!);
    expect(gaps.length).toBeGreaterThan(2);
    expect(gaps[0]).toBe(INDEXING_POLL_MS * 2);
    expect(gaps.every((gap, i) => i === 0 || gap >= gaps[i - 1]!)).toBe(true);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
  });
});
