import type { KbNotification } from '../api/b2';
import type { IconName } from '../ui';

export type Tone = 'r' | 'y' | 'a';

const KINDS: Record<string, { icon: IconName; tone: Tone; open: string }> = {
  discrepancy: { icon: 'warning', tone: 'r', open: 'Compare' },
  doubtful_corrections: { icon: 'fixes', tone: 'y', open: 'Review' },
  link_failed: { icon: 'link', tone: 'r', open: 'Details' },
  import_failed: { icon: 'error', tone: 'r', open: 'Details' },
  ingest_failed: { icon: 'error', tone: 'r', open: 'Details' },
  excluded_instruction: { icon: 'shield', tone: 'y', open: 'Review' },
  blocked_output: { icon: 'shield', tone: 'r', open: 'Details' },
  connections_found: { icon: 'graph', tone: 'a', open: 'Open' },
  concept_updated: { icon: 'concept', tone: 'a', open: 'Open' },
  material_ready: { icon: 'ready', tone: 'a', open: 'Open' },
};

/** Icon, tone and "open" word of a kind. An unknown kind is shown as ordinary "New" (API-B2 §1.1). */
export function kindOf(n: Pick<KbNotification, 'kind'>): { icon: IconName; tone: Tone; open: string } {
  return KINDS[n.kind] ?? { icon: 'bell', tone: 'a', open: 'Open' };
}

/** Kinds whose decision window has its own screen; the rest get the generic one. */
export const DECISION_SCREENS = new Set(['discrepancy', 'doubtful_corrections', 'link_failed', 'excluded_instruction']);

/** The quick action shown in the feed: the primary one, unless it needs text. */
export function quickAction(n: KbNotification) {
  return n.actions.find((a) => a.primary && !a.needs_text) ?? null;
}

/** Actions the client carries out itself (navigation) instead of resolving the notification. */
export const LOCAL_ACTIONS = new Set(['open_material']);
