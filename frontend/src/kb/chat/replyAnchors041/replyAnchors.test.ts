import { describe, expect, it } from 'vitest';

import {
  ACTIVE_PIN_SLACK_PX,
  ANCHOR_TOP_OFFSET_PX,
  NO_INTENT,
  RETURN_VISIBLE_SLACK_PX,
  STICK_SLACK_PX,
  anchorTargetTop,
  distanceToBottom,
  initialAnchorState,
  isAtBottom,
  reduceAnchors,
  shouldShowReturn,
  type AnchorMeasurement,
  type AnchorState,
  type ReplyId,
  type ScrollViewState,
} from './replyAnchors';

// B1 — SKAZ 0.4.1, decision 04: the reply-anchor state machine, pure. Thresholds follow the
// accepted unified mock: reading line +90, jump offset 75, last-answer pin < 20, stick < 40,
// return button from 90 up.

const A1: ReplyId = 'a1';
const A2: ReplyId = 'a2';
const A3: ReplyId = 'a3';

function anchor(top: number, height: number): AnchorMeasurement {
  return { top, height };
}

function view(scrollTop: number, viewportHeight = 600, scrollHeight = 3000): ScrollViewState {
  return { scrollTop, viewportHeight, scrollHeight };
}

/** ids a1..a3 measured at 0 / 1000 / 2000 (heights 300), no view yet. */
function thread(): AnchorState {
  let s = initialAnchorState();
  s = reduceAnchors(s, { type: 'replies', ids: [A1, A2, A3] });
  s = reduceAnchors(s, { type: 'measured', id: A1, measurement: anchor(0, 300) });
  s = reduceAnchors(s, { type: 'measured', id: A2, measurement: anchor(1000, 300) });
  s = reduceAnchors(s, { type: 'measured', id: A3, measurement: anchor(2000, 300) });
  return s;
}

describe('empty and initial state', () => {
  it('no replies: no active, no targets, at bottom, nothing to return to', () => {
    const s = initialAnchorState();
    expect(s.ids).toEqual([]);
    expect(s.activeId).toBeNull();
    expect(s.previousId).toBeNull();
    expect(s.nextId).toBeNull();
    expect(s.atBottom).toBe(true);
    expect(s.showReturn).toBe(false);
    expect(s.intent).toBe(NO_INTENT);
  });

  it('ids without a view yet: the first reply is current, like the approved mock', () => {
    const s = thread();
    expect(s.activeId).toBe(A1);
    expect(s.nextId).toBe(A2);
    expect(s.atBottom).toBe(true);
    expect(s.showReturn).toBe(false);
  });
});

describe('the active marker follows the reading line', () => {
  it('the lowest reply at or above the line is current', () => {
    let s = reduceAnchors(thread(), { type: 'view', view: view(0) });
    expect(s.activeId).toBe(A1);
    s = reduceAnchors(s, { type: 'view', view: view(1000) });
    expect(s.activeId).toBe(A2);
    expect(s.previousId).toBe(A1);
    expect(s.nextId).toBe(A3);
    s = reduceAnchors(s, { type: 'view', view: view(2350) });
    expect(s.activeId).toBe(A3);
  });

  it('near the bottom (within ACTIVE_PIN_SLACK_PX) the newest answer is current again', () => {
    const s = reduceAnchors(thread(), { type: 'view', view: view(3000 - 600 - ACTIVE_PIN_SLACK_PX + 1) });
    expect(s.activeId).toBe(A3);
  });

  it('above the first reply the first anchor stays current', () => {
    let s = thread();
    // The first reply sits below a long question: nothing crosses the line yet.
    s = reduceAnchors(s, { type: 'measured', id: A1, measurement: anchor(400, 300) });
    s = reduceAnchors(s, { type: 'view', view: view(0) });
    expect(s.activeId).toBe(A1);
  });

  it('unmeasured replies are skipped, and their dots cannot jump yet', () => {
    let s = initialAnchorState();
    s = reduceAnchors(s, { type: 'replies', ids: [A1, A2] });
    s = reduceAnchors(s, { type: 'measured', id: A1, measurement: anchor(0, 300) });
    s = reduceAnchors(s, { type: 'view', view: view(1000) });
    expect(s.activeId).toBe(A1); // a2 has no measurement: best effort, not a guess
    const jumped = reduceAnchors(s, { type: 'select', id: A2 });
    expect(jumped.intent).toBe(NO_INTENT);
    expect(jumped).toBe(s);
  });
});

describe('keyboard ↑/↓ go to the previous/next answer', () => {
  it('from the middle reply both directions jump to the measured neighbor', () => {
    const s = reduceAnchors(thread(), { type: 'view', view: view(1000) });
    const next = reduceAnchors(s, { type: 'keyboard', direction: 'next' });
    expect(next.intent).toEqual({ kind: 'jumpToReply', id: A3, top: 2000 - ANCHOR_TOP_OFFSET_PX, behavior: 'smooth' });
    const prev = reduceAnchors(s, { type: 'keyboard', direction: 'previous' });
    expect(prev.intent).toEqual({ kind: 'jumpToReply', id: A1, top: 0, behavior: 'smooth' });
  });

  it('at the ends the keys do nothing: they go to answers, not past them', () => {
    let s = reduceAnchors(thread(), { type: 'view', view: view(0) }); // reading a1
    expect(reduceAnchors(s, { type: 'keyboard', direction: 'previous' })).toBe(s);
    s = reduceAnchors(s, { type: 'view', view: view(2400) }); // pinned to a3 at the bottom
    expect(reduceAnchors(s, { type: 'keyboard', direction: 'next' })).toBe(s);
  });
});

describe('dot clicks, the return button and the consumed find intent', () => {
  it('a dot click jumps to the reply anchor with the mock offset, clamped at 0', () => {
    const s = reduceAnchors(thread(), { type: 'view', view: view(1000) });
    expect(reduceAnchors(s, { type: 'select', id: A2 }).intent)
      .toEqual({ kind: 'jumpToReply', id: A2, top: 925, behavior: 'smooth' });
    expect(reduceAnchors(s, { type: 'select', id: A1 }).intent)
      .toEqual({ kind: 'jumpToReply', id: A1, top: 0, behavior: 'smooth' });
  });

  it('R1: the find intent is consumed without a jump — A4 owns exact-match scrolling', () => {
    const s = reduceAnchors(thread(), { type: 'view', view: view(1000) });
    // Repeated matches inside one reply, even an unknown target: never a jump, never a guess.
    expect(reduceAnchors(s, { type: 'search', id: A2 })).toBe(s);
    expect(reduceAnchors(s, { type: 'search', id: A2 })).toBe(s);
    expect(reduceAnchors(s, { type: 'search', id: 'gone' })).toBe(s);
    expect(s.intent).toBe(NO_INTENT);
  });

  it('R1: after A4 centers a match deep inside a long reply, the marker follows the viewport', () => {
    let s = initialAnchorState();
    s = reduceAnchors(s, { type: 'replies', ids: [A1, A2] });
    s = reduceAnchors(s, { type: 'measured', id: A1, measurement: anchor(100, 3000) });
    s = reduceAnchors(s, { type: 'measured', id: A2, measurement: anchor(3400, 400) });
    // The find placed its exact match at y=1900: A4 scrolled here itself (viewport 500).
    s = reduceAnchors(s, { type: 'view', view: view(1820, 500, 3900) });
    expect(s.activeId).toBe(A1); // derived from the actual viewport, not from a jump to y=25
    expect(reduceAnchors(s, { type: 'search', id: A1 })).toBe(s);
    expect(s.intent).toBe(NO_INTENT);
  });

  it('returnToLatest always asks for the bottom of the thread', () => {
    const s = reduceAnchors(thread(), { type: 'view', view: view(1000) });
    expect(reduceAnchors(s, { type: 'returnToLatest' }).intent).toEqual({ kind: 'jumpToBottom', behavior: 'smooth' });
  });
});

describe('the intent is one-shot', () => {
  it('the view event that follows an applied intent clears it — even an identical view', () => {
    let s = reduceAnchors(thread(), { type: 'view', view: view(1000) });
    s = reduceAnchors(s, { type: 'select', id: A2 });
    expect(s.intent.kind).toBe('jumpToReply');
    const cleared = reduceAnchors(s, { type: 'view', view: view(1000) });
    expect(cleared.intent).toBe(NO_INTENT);
    expect(cleared).not.toBe(s);
  });

  it('a repeated identical view with no pending intent changes nothing (no re-render churn)', () => {
    let s = reduceAnchors(thread(), { type: 'view', view: view(1000) });
    const again = reduceAnchors(s, { type: 'view', view: view(1000) });
    expect(again).toBe(s);
  });

  it('a changed reply list makes a pending intent stale and clears it', () => {
    let s = reduceAnchors(thread(), { type: 'view', view: view(1000) });
    s = reduceAnchors(s, { type: 'select', id: A2 });
    s = reduceAnchors(s, { type: 'replies', ids: [A1, A2, A3, 'a4'] });
    expect(s.intent).toBe(NO_INTENT);
  });
});

describe('replies: ordered ids, stable through streaming', () => {
  it('a fresh array with the same elements is a no-op (the host may rebuild it every render)', () => {
    const s = thread();
    expect(reduceAnchors(s, { type: 'replies', ids: [...s.ids] })).toBe(s);
  });

  it('a new reply keeps the old ids and their measurements; a removed one is pruned', () => {
    let s = thread();
    s = reduceAnchors(s, { type: 'replies', ids: [A1, A2, A3, 'a4'] });
    expect(s.ids).toEqual([A1, A2, A3, 'a4']);
    expect(s.measurements[A1]).toEqual({ top: 0, height: 300 });
    expect(s.measurements['a4']).toBeUndefined();
    s = reduceAnchors(s, { type: 'replies', ids: [A1, A3] });
    expect(s.ids).toEqual([A1, A3]);
    expect(s.measurements[A2]).toBeUndefined();
    expect(s.measurements[A3]).toEqual({ top: 2000, height: 300 });
  });

  it('measured for an id that is not in the list yet is ignored', () => {
    const s = thread();
    expect(reduceAnchors(s, { type: 'measured', id: 'stranger', measurement: anchor(5, 5) })).toBe(s);
  });
});

describe('streaming never scrolls on its own (decision 6)', () => {
  it('a reply growing under the reading line: no intent, the user\'s place and marker stay', () => {
    let s = reduceAnchors(thread(), { type: 'view', view: view(1000) });
    expect(s.activeId).toBe(A2);
    s = reduceAnchors(s, { type: 'measured', id: A2, measurement: anchor(1000, 800) });
    expect(s.intent).toBe(NO_INTENT);
    expect(s.activeId).toBe(A2);
    expect(s.showReturn).toBe(true);
    // The same values again: referentially calm.
    expect(reduceAnchors(s, { type: 'measured', id: A2, measurement: anchor(1000, 800) })).toBe(s);
  });

  it('content growing while the user is at the bottom keeps the newest answer current', () => {
    let s = reduceAnchors(thread(), { type: 'view', view: view(2400) });
    expect(s.activeId).toBe(A3);
    s = reduceAnchors(s, { type: 'measured', id: A3, measurement: anchor(2000, 900) });
    s = reduceAnchors(s, { type: 'replies', ids: [A1, A2, A3, 'a4'] });
    expect(s.intent).toBe(NO_INTENT);
    expect(s.activeId).toBe('a4'); // at the bottom the pin moves to the new streaming reply
  });
});

describe('at-bottom and return-button thresholds', () => {
  it('stick slack, pin slack and return visibility land on the mock\'s numbers', () => {
    expect(distanceToBottom(view(0, 600, 600))).toBe(0);
    expect(isAtBottom(view(0, 600, 600 + STICK_SLACK_PX - 1))).toBe(true);
    expect(isAtBottom(view(0, 600, 600 + STICK_SLACK_PX))).toBe(false);
    expect(isAtBottom(null)).toBe(true);
    expect(shouldShowReturn(view(0, 600, 600 + RETURN_VISIBLE_SLACK_PX))).toBe(true);
    expect(shouldShowReturn(view(0, 600, 600 + RETURN_VISIBLE_SLACK_PX - 1))).toBe(false);
    expect(shouldShowReturn(null)).toBe(false);
  });

  it('anchorTargetTop clamps above the first reply', () => {
    expect(anchorTargetTop(anchor(40, 300))).toBe(0);
    expect(anchorTargetTop(anchor(1000, 300))).toBe(1000 - ANCHOR_TOP_OFFSET_PX);
  });
});
