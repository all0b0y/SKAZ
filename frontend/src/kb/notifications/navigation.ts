// Notification buttons that navigate (0.4.0: B2 «Open in Explore», B6 weekly check). The client carries them
// out itself; the backend never resolves them (`notifications/feed.py` NAVIGATION_ACTIONS).
import type { KbNotification } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { exploreStart } from '../api/explore';
import { maintenanceCheck } from '../api/maintenance';
import { weeklySelection } from '../explore/weeklySelection';
import { getResearchStore } from '../research/store';
import type { KbServices } from '../state/context';

export const NAVIGATION_ACTIONS = new Set(['open_explore', 'open_research_task', 'view_check', 'check_novelty', 'review_updates']);

export type NavigationResult = { ok: true } | { ok: false; error: string };

/**
 * - Open in Explore / View check → the Explore section (its progress line shows the running check).
 * - Check novelty → a new run over the candidates the weekly check left waiting (the paid step, on this click
 *   only), then Explore.
 * - Open task (B3 research_finished) → the research task view (`payload.task_id`), as the Research list does.
 * - Review source updates → All materials: the marks show on each material (there is no list of marked
 *   materials in 0.4.0).
 */
export async function runNavigation(
  services: Pick<KbServices, 'client' | 'prefs' | 'chats' | 'ui'>,
  n: Pick<KbNotification, 'payload'>,
  action: string,
): Promise<NavigationResult> {
  // The rail section AND the centre: an expanded document would keep the target out of view, and the
  // centre view is its own state (review R3-14).
  const go = (section: 'explore' | 'materials' | 'chats') => {
    services.prefs.getState().set({ section, sideOpen: true });
    const ui = services.ui.getState();
    if (ui.docExpanded) ui.toggleDocExpanded();
    if (section === 'materials') ui.showCenter('materials');
    if (section === 'chats') ui.showCenter('chat');
  };
  if (action === 'open_research_task') {
    const taskId = (n.payload as { task_id?: unknown }).task_id;
    if (typeof taskId !== 'string') return { ok: false, error: 'This task is no longer available.' };
    go('chats');
    getResearchStore(services.client).getState().openTask(taskId);
    return { ok: true };
  }
  if (action === 'view_check') {
    const checkId = (n.payload as { job_id?: unknown }).job_id;
    if (typeof checkId !== 'string') return { ok: false, error: 'This check is no longer available.' };
    weeklySelection(services.client).setState({ checkId });
  }
  if (action === 'check_novelty') {
    const checkId = (n.payload as { job_id?: unknown }).job_id;
    if (typeof checkId !== 'string') return { ok: false, error: 'This check is no longer available.' };
    try {
      const check = await maintenanceCheck(services.client, checkId);
      if (check.candidate_ids.length === 0) {
        go('explore');
        return { ok: false, error: 'No candidates are waiting any more.' };
      }
      await exploreStart(services.client, { candidate_ids: check.candidate_ids.slice(0, 100), channels: [] });
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
    go('explore');
    return { ok: true };
  }
  go(action === 'review_updates' ? 'materials' : 'explore');
  return { ok: true };
}
