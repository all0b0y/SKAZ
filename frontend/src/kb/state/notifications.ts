import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbNotification } from '../api/b2';
import { errorText, type KbClient } from '../api/client';
import type { ActionResult, Load } from './library';
import { longPoll } from './poll';

export interface NotificationsData {
  /** Not dismissed, newest first (by `created_at`). */
  items: KbNotification[];
  cursor: number;
  unread: number;
  requiresAction: number;
  load: Load;
  error: string | null;
}

export interface NotificationsActions {
  /** Read the feed and keep it live (long poll). Returns stop. */
  start: () => () => void;
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<ActionResult>;
  resolve: (id: string, action: string, text?: string | null) => Promise<ActionResult<KbNotification>>;
  /** Everything seen so far is read: the bell counter goes to zero. */
  markRead: () => Promise<void>;
}

export type NotificationsStore = StoreApi<NotificationsData & NotificationsActions>;

const newestFirst = (a: KbNotification, b: KbNotification) => b.created_at.localeCompare(a.created_at) || b.seq - a.seq;

/** The ones waiting for a decision, in feed order (the ‹ › order of the decision window). */
export function pendingDecisions(items: KbNotification[]): KbNotification[] {
  return items.filter((n) => n.requires_action && !n.resolved_at);
}

export function createNotificationsStore(client: KbClient): NotificationsStore {
  return createStore<NotificationsData & NotificationsActions>()((set, get) => {
    const merge = (incoming: KbNotification[], replace: boolean) => {
      const byId = new Map((replace ? [] : get().items).map((n) => [n.id, n]));
      for (const n of incoming) {
        if (n.dismissed_at) byId.delete(n.id);
        else byId.set(n.id, n);
      }
      return [...byId.values()].sort(newestFirst);
    };
    const apply = (after: number, feed: Awaited<ReturnType<KbClient['notifications']>>) => {
      // A full answer (first read, or an older backend without a cursor) replaces the list.
      const replace = after === 0 || feed.cursor === 0;
      const items = merge(feed.items, replace);
      set({ items, cursor: feed.cursor, unread: feed.unread, requiresAction: feed.requires_action, load: 'ready', error: null });
      return items;
    };
    return {
      items: [],
      cursor: 0,
      unread: 0,
      requiresAction: 0,
      load: 'idle',
      error: null,

      refresh: async () => {
        if (get().load !== 'ready') set({ load: 'loading' });
        try {
          apply(0, await client.notifications());
        } catch (error) {
          set({ load: 'error', error: errorText(error) });
        }
      },

      start: () => longPoll(async (cursor, wait) => {
        try {
          const feed = await client.notifications(cursor || undefined, cursor ? wait : undefined);
          apply(cursor, feed);
          return { cursor: feed.cursor, changed: feed.cursor !== 0 && feed.cursor !== cursor };
        } catch (error) {
          set({ load: get().load === 'ready' ? 'ready' : 'error', error: errorText(error) });
          throw error;
        }
      }, get().cursor),

      dismiss: async (id) => {
        const before = get().items;
        set({ items: before.filter((n) => n.id !== id) });
        try {
          await client.call('POST /kb/notifications/{notification_id}/dismiss', { path: { notification_id: id } });
          return { ok: true, value: undefined };
        } catch (error) {
          set({ items: before });
          return { ok: false, error: errorText(error) };
        }
      },

      resolve: async (id, action, text) => {
        try {
          const updated = await client.call('POST /kb/notifications/{notification_id}/resolve', {
            path: { notification_id: id }, body: { action, text: text ?? null },
          });
          const items = get().items.map((n) => (n.id === id ? { ...n, ...updated } : n));
          set({ items, requiresAction: pendingDecisions(items).length });
          return { ok: true, value: updated };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      markRead: async () => {
        const top = Math.max(0, ...get().items.map((n) => n.seq));
        if (get().unread === 0 || top === 0) return;
        set({ unread: 0 });
        try {
          await client.call('POST /kb/notifications/read', { body: { up_to_seq: top } });
        } catch {
          /* The counter comes back with the next answer if the backend did not record it. */
        }
      },
    };
  });
}
