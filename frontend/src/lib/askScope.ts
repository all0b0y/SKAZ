import type { ApiClient } from '../api/client';
import type { AskRequest, ChatScope, Session } from '../api/types';
import { importLegacyGroups, loadGroups } from './sessionGroups';

/** Read group membership at submit, not a possibly stale mounted navigator. */
export async function askScope(
  api: ApiClient, scope: ChatScope, current: string, sessions: Session[],
): Promise<Pick<AskRequest, 'search_scope' | 'group_session_ids'>> {
  if (scope !== 'group') return { search_scope: scope };
  const layout = await api.getStorageLayout();
  if (layout.pending) throw new Error('Storage recovery required. Open Settings → Files.');
  // Backend re-reads managed membership atomically with the source snapshot.
  if (layout.enabled) return { search_scope: scope };
  const groups = importLegacyGroups(loadGroups(), sessions);
  const group = groups.membership[current];
  if (!group) throw new Error('The current session has no group. Choose Session or All.');
  const ids = sessions.filter((session) => groups.membership[session.id] === group).map((s) => s.id);
  return { search_scope: scope, group_session_ids: ids };
}
