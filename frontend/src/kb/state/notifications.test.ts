import { describe, expect, it } from 'vitest';
import type { KbNotificationFeed } from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';
import { createNotificationsStore } from './notifications';
import { WAIT_S } from './poll';

const empty: KbNotificationFeed = { items: [], cursor: 0, unread: 0, requires_action: 0 } as unknown as KbNotificationFeed;

describe('Notifications long poll (QA E4)', () => {
  it('holds a real long poll even while the feed is empty (cursor 0), instead of asking every 3 s', async () => {
    const calls: Array<[number | undefined, number | undefined]> = [];
    let release: (() => void) | undefined;
    const client = {
      notifications: (after?: number, wait?: number) => {
        calls.push([after, wait]);
        if (calls.length === 1) return Promise.resolve(empty);
        // The second request is the long poll: it stays open (the backend holds it up to WAIT_S).
        return new Promise<KbNotificationFeed>((resolve) => { release = () => resolve(empty); });
      },
    } as unknown as KbClient;
    const store = createNotificationsStore(client);
    const stop = store.getState().start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([[undefined, undefined], [0, WAIT_S]]);
    stop();
    release?.();
  });
});
