import type { KbFragment, KbLiveMonologue, KbRecordingLive } from '../../api/kb/types.gen';

/**
 * The live panel's text after a recording's fragments (`GET /kb/recordings/{id}/live`).
 *
 * The material holds closed monologues only; the open one (final words of the current speaker
 * with no pause yet) and the words still being recognised come from the live answer, which says
 * which fragment it continues (`after_seg`). The material and the live answer are polled apart,
 * so one can be a step ahead of the other: this keeps the text from appearing twice or leaving a gap.
 */
export interface LiveText {
  /** Final words, stable: they never change, they only move into the material when the monologue closes. */
  monologues: KbLiveMonologue[];
  /** Words the speech service may still revise (grey). */
  partial: { speaker: string | null; text: string; translation: string } | null;
}

export const EMPTY_LIVE: LiveText = { monologues: [], partial: null };

export function lastSeg(fragments: readonly KbFragment[]): number {
  let seg = 0;
  for (const f of fragments) if (f.seg > seg) seg = f.seg;
  return seg;
}

/**
 * The live text that fits a material whose last fragment is `seg`, or `'material-behind'` when the
 * answer continues fragments the material hasn't loaded yet (keep showing the previous text and
 * reload the material — showing this one would drop the monologue that just closed).
 *
 * A material that is newer than the answer already holds its first monologues (one closed monologue
 * is one fragment), so they are left out; its non-final words may be in them too, so they wait for
 * the next answer rather than show twice.
 */
export function liveAfter(live: KbRecordingLive, seg: number): LiveText | 'material-behind' {
  if (live.after_seg > seg) return 'material-behind';
  const closed = seg - live.after_seg;
  if (closed === 0) return { monologues: live.monologues, partial: live.partial };
  return { monologues: live.monologues.slice(closed), partial: null };
}
