import type { KbCitation, KbNotification } from '../../api/kb/types.gen';
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

// `KbNotification.payload` is a free dict in the contract (API-B2 §1.1 fixes its keys per kind); these
// are the keys the decision screens read. The backend writes them in knowledge/wiki/discrepancy.py,
// corrections/check.py and speech/link_failures.py.

export interface KbDiscrepancySide {
  block_id: string;
  text: string;
  /** null when the block lost its citation before the notice was written. */
  citation: KbCitation | null;
  material_title: string;
  folder_name: string;
}

export interface KbDiscrepancyPayload {
  page_id: string;
  page_title: string;
  sides: KbDiscrepancySide[];
  explanation_block_id: string | null;
  /** Not written by the backend today (the text lives in the block `explanation_block_id`); shown when present. */
  explanation?: string | null;
}

export interface KbDoubtfulPayload {
  material_id: string;
  material_title: string;
  correction_ids: string[];
}

export interface KbLinkFailedPayload {
  material_id: string;
  material_title?: string;
  url: string;
  reason: string;
}
