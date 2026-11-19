/*
 * B1 — SKAZ 0.4.1, decision 04 «reply anchors»: the public surface. The ChatView wiring (a
 * separate dispatch) imports this module, marks the log scroller `data-anchors="true"` and
 * focusable, renders `ReplyAnchorRail`/`ReturnToLatest` beside the scroller, and feeds the hook
 * `chat.messages` → ordered assistant reply ids. The in-chat find (A4) calls
 * `consumeSearch(replyId)`: consumed as a notification only — A4 owns exact-match scrolling, so
 * B1 syncs its marker from the viewport and never jumps on it. Tab selection stays out of scope.
 */

import './replyAnchors.css';

export {
  ACTIVE_PIN_SLACK_PX,
  ANCHOR_TOP_OFFSET_PX,
  NO_INTENT,
  READING_LINE_PX,
  RETURN_VISIBLE_SLACK_PX,
  STICK_SLACK_PX,
  anchorTargetTop,
  distanceToBottom,
  initialAnchorState,
  isAtBottom,
  reduceAnchors,
  shouldShowReturn,
} from './replyAnchors';
export type { AnchorEvent, AnchorMeasurement, AnchorState, ReplyId, ScrollViewState, ScrollIntent } from './replyAnchors';

export { anchorNavigationDirection, isEditableTarget, navigationDirection } from './keyGuard';
export type { NavigationKeyInput } from './keyGuard';

export { measureReplyAnchor, measureReplyAnchors, replyAnchorElement } from './measure';
export type { MeasuredAnchor } from './measure';

export { useReplyAnchors } from './useReplyAnchors';
export type { ReplyAnchorsHandle, UseReplyAnchorsOptions } from './useReplyAnchors';

export { ReplyAnchorRail } from './ReplyAnchorRail';
export type { ReplyAnchorRailProps } from './ReplyAnchorRail';
export { ReturnToLatest } from './ReturnToLatest';
export type { ReturnToLatestProps } from './ReturnToLatest';
