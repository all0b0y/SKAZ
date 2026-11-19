/*
 * B1 — SKAZ 0.4.1, decision 04 «Якоря по ответам» (accepted variant A; thresholds follow the
 * approved unified mock `.dev/task-context/navigation-mockup.html`).
 *
 * One anchor per assistant reply. The host feeds this reducer the ordered reply ids, one measured
 * anchor per reply (content coordinates), and view/scroll changes; it answers with the active,
 * previous and next reply id plus a one-shot scroll intent. It never scrolls on its own: content
 * growth while streaming leaves the user's manual reading position alone (decision 6), and the
 * only scroll intents come from explicit navigation — a dot click, ↑/↓ outside inputs, or the
 * return-to-latest button. The external find intent (`search`) is consumed as a notification
 * only: the find (A4) owns exact-match scrolling, so it never emits a jump and the marker syncs
 * from the viewport.
 *
 * Tab selection and the find panel itself are other tasks (05 / tab store): this module only
 * consumes their navigation intents; it implements neither.
 */

export type ReplyId = string;

/** One measured anchor: the reply's top edge in scroll-content coordinates, and its height. */
export interface AnchorMeasurement {
  top: number;
  /** Grows while the answer streams; only measurement changes, the id stays stable. */
  height: number;
}

/** A view/scroll snapshot of the log container. */
export interface ScrollViewState {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
}

/** The reading line sits this far below the viewport top (mock: `+ 90`). */
export const READING_LINE_PX = 90;
/** A jump places the reply's top this far below the viewport top (mock: `offsetTop - 75`). */
export const ANCHOR_TOP_OFFSET_PX = 75;
/** Within this distance of the bottom the last reply is the active one (mock: `< 20`). */
export const ACTIVE_PIN_SLACK_PX = 20;
/** Within this distance the user counts as «at the bottom» (ChatView's stick slack: `< 40`). */
export const STICK_SLACK_PX = 40;
/** Farther than this from the bottom, the return-to-latest button shows (mock: hidden `< 90`). */
export const RETURN_VISIBLE_SLACK_PX = 90;

/** What the host should scroll to for the latest explicit navigation; one-shot (see the reducer). */
export type ScrollIntent =
  | { kind: 'none' }
  | { kind: 'jumpToReply'; id: ReplyId; top: number; behavior: 'smooth' }
  | { kind: 'jumpToBottom'; behavior: 'smooth' };

/** The shared frozen «nothing to do» so equal states stay referentially equal. */
export const NO_INTENT: ScrollIntent = { kind: 'none' };

export function distanceToBottom(view: ScrollViewState): number {
  return view.scrollHeight - view.scrollTop - view.viewportHeight;
}

/** Is the user effectively at the bottom (the streaming stick zone)? No view yet counts as yes. */
export function isAtBottom(view: ScrollViewState | null): boolean {
  return view === null || distanceToBottom(view) < STICK_SLACK_PX;
}

/** The return-to-latest button appears only once the user has left the bottom (decision 04 §4). */
export function shouldShowReturn(view: ScrollViewState | null): boolean {
  return view !== null && distanceToBottom(view) >= RETURN_VISIBLE_SLACK_PX;
}

/** Where a jump to `measurement` should land the scrollTop. */
export function anchorTargetTop(measurement: AnchorMeasurement): number {
  return Math.max(0, measurement.top - ANCHOR_TOP_OFFSET_PX);
}

export type AnchorEvent =
  /** The ordered assistant reply ids changed (new, removed, reordered replies). */
  | { type: 'replies'; ids: readonly ReplyId[] }
  /** One reply was (re)measured; ids stay stable while their height streams. */
  | { type: 'measured'; id: ReplyId; measurement: AnchorMeasurement }
  /** The view/scroll changed; never the source of an intent. */
  | { type: 'view'; view: ScrollViewState }
  /** A dot was clicked. */
  | { type: 'select'; id: ReplyId }
  /** External navigation (the in-chat find, A4) pointed into `id`; consumed without scrolling. */
  | { type: 'search'; id: ReplyId }
  /** Bare ↑/↓ outside inputs, guarded by the host. */
  | { type: 'keyboard'; direction: 'previous' | 'next' }
  /** The explicit «return to the latest message» button. */
  | { type: 'returnToLatest' };

export interface AnchorState {
  /** Ordered assistant reply ids, a copy owned by this state. */
  ids: ReplyId[];
  /** One measured anchor per reply; replies not yet measured are missing. */
  measurements: Partial<Record<ReplyId, AnchorMeasurement>>;
  /** The last view/scroll snapshot; null until the host reports one. */
  view: ScrollViewState | null;
  /** The reply the user is reading; the marker's long dash. */
  activeId: ReplyId | null;
  /** The ↑ / ↓ keyboard targets around `activeId`. */
  previousId: ReplyId | null;
  nextId: ReplyId | null;
  atBottom: boolean;
  showReturn: boolean;
  intent: ScrollIntent;
}

export function initialAnchorState(): AnchorState {
  return {
    ids: [], measurements: {}, view: null,
    activeId: null, previousId: null, nextId: null,
    atBottom: true, showReturn: false, intent: NO_INTENT,
  };
}

function sameIds(a: readonly ReplyId[], b: readonly ReplyId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameView(a: ScrollViewState | null, b: ScrollViewState | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.scrollTop === b.scrollTop && a.viewportHeight === b.viewportHeight && a.scrollHeight === b.scrollHeight;
}

/**
 * The reply at the reading line: the lowest measured anchor at or above it (mock `closestIndex`).
 * Above the first reply the first anchor stays current, and near the bottom (within
 * ACTIVE_PIN_SLACK_PX) the last reply wins — the newest answer is «current» again.
 */
function activeIdOf(ids: readonly ReplyId[], measurements: Partial<Record<ReplyId, AnchorMeasurement>>, view: ScrollViewState | null): ReplyId | null {
  const first = ids[0];
  if (first === undefined) return null;
  if (view === null) return first;
  if (distanceToBottom(view) < ACTIVE_PIN_SLACK_PX) return ids[ids.length - 1] ?? first;
  const line = view.scrollTop + READING_LINE_PX;
  let active: ReplyId | null = null;
  let top = -Infinity;
  for (const id of ids) {
    const m = measurements[id];
    if (m === undefined || m.top > line) continue;
    if (m.top >= top) { active = id; top = m.top; }
  }
  return active ?? first;
}

/** Recompute everything that follows from ids + measurements + view. Clear the one-shot intent. */
function withGeometry(ids: ReplyId[], measurements: Partial<Record<ReplyId, AnchorMeasurement>>, view: ScrollViewState | null): AnchorState {
  const activeId = activeIdOf(ids, measurements, view);
  const index = activeId === null ? -1 : ids.indexOf(activeId);
  return {
    ids,
    measurements,
    view,
    activeId,
    previousId: index > 0 ? ids[index - 1] ?? null : null,
    nextId: index >= 0 && index + 1 < ids.length ? ids[index + 1] ?? null : null,
    atBottom: isAtBottom(view),
    showReturn: shouldShowReturn(view),
    intent: NO_INTENT,
  };
}

/** A jump to a reply needs its measurement: an unmeasured target is a no-op, not a guess. */
function jumpIntent(state: AnchorState, id: ReplyId): ScrollIntent {
  const m = state.measurements[id];
  return m === undefined ? NO_INTENT : { kind: 'jumpToReply', id, top: anchorTargetTop(m), behavior: 'smooth' };
}

function withIntent(prev: AnchorState, intent: ScrollIntent): AnchorState {
  return prev.intent === intent ? prev : { ...prev, intent };
}

/**
 * The reply-anchor state machine. Referentially calm: an event that changes nothing observable
 * returns the previous state object, so scroll storms and streamed token batches do not re-render.
 * The intent is one-shot: applying it (or any later view/replies/measured event) clears it.
 */
export function reduceAnchors(prev: AnchorState, event: AnchorEvent): AnchorState {
  switch (event.type) {
    case 'replies': {
      if (sameIds(prev.ids, event.ids)) return prev;
      const ids = [...event.ids];
      const measurements: Partial<Record<ReplyId, AnchorMeasurement>> = {};
      for (const id of ids) {
        const m = prev.measurements[id];
        if (m !== undefined) measurements[id] = m;
      }
      // A changed reply list makes a pending intent's target stale.
      return withGeometry(ids, measurements, prev.view);
    }
    case 'measured': {
      const before = prev.measurements[event.id];
      if (before !== undefined && before.top === event.measurement.top && before.height === event.measurement.height) return prev;
      if (before === undefined && !prev.ids.includes(event.id)) return prev;
      // Streamed growth is a re-measurement, never a scroll: the user's place stays (decision 6).
      return withGeometry(prev.ids, { ...prev.measurements, [event.id]: event.measurement }, prev.view);
    }
    case 'view': {
      if (sameView(prev.view, event.view) && prev.intent === NO_INTENT) return prev;
      // One-shot consumption: the view that follows an applied intent clears it.
      return withGeometry(prev.ids, prev.measurements, event.view);
    }
    case 'select':
      return withIntent(prev, jumpIntent(prev, event.id));
    case 'search':
      // The in-chat find (A4) owns exact-match scrolling: consuming its navigation never queues
      // a jump, not even for repeated matches inside one reply. B1's marker syncs from the
      // viewport — the hook snapshots it, and A4's own scroll events keep it current.
      return prev;
    case 'keyboard': {
      const target = event.direction === 'previous' ? prev.previousId : prev.nextId;
      // At the ends of the thread ↑/↓ do nothing: they go to the previous/next answer, not past it.
      return withIntent(prev, target === null ? NO_INTENT : jumpIntent(prev, target));
    }
    case 'returnToLatest':
      return withIntent(prev, { kind: 'jumpToBottom', behavior: 'smooth' });
  }
}
