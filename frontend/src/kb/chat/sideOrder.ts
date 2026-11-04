import type { KbChatSummary } from '../../api/kb/types.gen';
import { dayBucket, groupBy } from '../ui/time';

/** How many unpinned chats the side panel shows (the rest is under «All chats»). */
export const SIDE_LIMIT = 8;
/** The tab key of the «New chat» row (open while the centre shows a chat not created yet). */
export const NEW_CHAT_KEY = '__new';

/** The side panel's chats as shown: pinned first, then the latest few grouped by day (v2/v16). */
export function sideChats(list: readonly KbChatSummary[]) {
  const pinned = list.filter((c) => c.pinned);
  const rest = list.filter((c) => !c.pinned).slice(0, SIDE_LIMIT);
  const groups = groupBy(rest, (c) => dayBucket(c.updated_at));
  return { pinned, rest, groups, order: [...pinned, ...groups.flatMap((g) => g.items)].map((c) => c.id) };
}

/**
 * Which way the content follows a chat switch (decision 25): +1 when the new row is below the old
 * one in the side list, −1 above. «New chat» (null) sits above every chat; a chat not in the side
 * list counts as below.
 */
export function switchDir(order: readonly string[], from: string | null, to: string | null): 1 | -1 {
  const at = (id: string | null) => (id === null ? -1 : order.includes(id) ? order.indexOf(id) : order.length);
  return at(to) < at(from) ? -1 : 1;
}
