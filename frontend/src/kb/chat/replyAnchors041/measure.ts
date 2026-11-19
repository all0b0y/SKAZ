/*
 * B1 — SKAZ 0.4.1, decision 04: the anchor measurement half of the module's input. The DOM
 * contract already exists in production: AssistantMessage and UserMessage carry
 * `data-message-id` (Message.tsx), so a reply is a stable anchor without touching its content.
 * Coordinates are content coordinates — scrolling does not move them; only content changes do.
 */

import type { AnchorMeasurement, ReplyId } from './replyAnchors';

export interface MeasuredAnchor {
  id: ReplyId;
  measurement: AnchorMeasurement;
}

/** The reply's element in the log, by its stable message id. */
export function replyAnchorElement(scroller: HTMLElement, id: ReplyId): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-message-id="${cssEscape(id)}"]`);
}

/**
 * One measured anchor: the reply's top edge in scroll-content coordinates (its
 * `getBoundingClientRect().top` relative to the scroller, plus the scroller's `scrollTop`) and
 * its height, which grows while the answer streams.
 */
export function measureReplyAnchor(scroller: HTMLElement, el: HTMLElement): AnchorMeasurement {
  const rect = el.getBoundingClientRect();
  const top = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  return { top, height: rect.height };
}

/** Measure every listed reply that is currently in the log; missing elements are skipped. */
export function measureReplyAnchors(scroller: HTMLElement, ids: readonly ReplyId[]): MeasuredAnchor[] {
  const out: MeasuredAnchor[] = [];
  for (const id of ids) {
    const el = replyAnchorElement(scroller, id);
    if (el) out.push({ id, measurement: measureReplyAnchor(scroller, el) });
  }
  return out;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}
