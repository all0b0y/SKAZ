import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';

import { ReplyAnchorRail } from './ReplyAnchorRail';
import { ReturnToLatest } from './ReturnToLatest';
import { useReplyAnchors } from './useReplyAnchors';

// B1 — SKAZ 0.4.1, decision 04: the ChatView half — measure, follow the view, apply intents,
// guard keys — against a fake log with the production DOM contract (`data-message-id`). jsdom has
// no layout, so geometry is defined per element; content coordinates stay fixed while scrollTop
// moves, exactly like a real scroller.

const A1 = 'a1';
const A2 = 'a2';
const A3 = 'a3';

interface AnchorSpec { id: string; top: number; height: number }

function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function stubAnchor(log: HTMLElement, spec: AnchorSpec): void {
  const node = log.querySelector<HTMLElement>(`[data-message-id="${spec.id}"]`);
  if (!node) throw new Error(`no element for anchor ${spec.id}`);
  Object.defineProperty(node, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect(spec.top - log.scrollTop, spec.height),
  });
}

/**
 * Geometry install: runs in the harness's layout effect, so it lands before the hook's passive
 * effects read the layout on mount. `scrollTop` is the user's starting place.
 */
function makePrepare(anchors: AnchorSpec[], opts: { scrollTop: number; viewport?: number; scrollHeight: number }) {
  let height = opts.scrollHeight;
  const scrollTo = vi.fn();
  const growTo = (n: number) => { height = n; };
  const prepare = (log: HTMLElement) => {
    Object.defineProperty(log, 'clientHeight', { value: opts.viewport ?? 600, configurable: true });
    Object.defineProperty(log, 'scrollHeight', { get: () => height, configurable: true });
    Object.defineProperty(log, 'getBoundingClientRect', { value: () => rect(0, opts.viewport ?? 600), configurable: true });
    for (const spec of anchors) stubAnchor(log, spec);
    log.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    log.scrollTop = opts.scrollTop;
  };
  return { prepare, scrollTo, growTo };
}

function Harness({ ids, prepare, reduced, search = A2, frozen }: {
  ids: string[];
  prepare?: (log: HTMLElement) => void;
  reduced?: boolean;
  search?: string;
  frozen?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { if (prepare && scrollRef.current) prepare(scrollRef.current); }, [prepare]);
  const anchors = useReplyAnchors(scrollRef, ids, { reducedMotion: reduced, frozen });
  return (
    <div style={{ position: 'relative' }}>
      <div ref={scrollRef} role="log" tabIndex={0}>
        {ids.map((id) => <article key={id} data-message-id={id} />)}
        {/* An edit-in-place field inside the log, like the user-message editor: its arrows stay its own. */}
        <input aria-label="Fake editor" />
      </div>
      <ReplyAnchorRail ids={anchors.state.ids} activeId={anchors.state.activeId} onGoToReply={anchors.goToReply} />
      <ReturnToLatest visible={anchors.state.showReturn} onReturn={anchors.returnToLatest} />
      <button type="button" onClick={() => anchors.consumeSearch(search)}>find jump</button>
      <button type="button" onClick={anchors.goNext}>next handle</button>
    </div>
  );
}

function dots() {
  return screen.getAllByRole('button', { name: /Go to model answer \d+/ });
}

function activeDotIndex(): number {
  return dots().findIndex((d) => d.getAttribute('aria-current') === 'true');
}

const log = () => screen.getByRole('log');

/** Scroll to an exact place and deliver the scroll event, like the browser would. */
function scrollTo(scrollTop: number) {
  act(() => { log().scrollTop = scrollTop; fireEvent.scroll(log()); });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the marker follows the view; the rail mirrors it', () => {
  it('one dot per reply, the active one marked; at the bottom the newest is current and no return button', () => {
    const { prepare } = makePrepare(
      [{ id: A1, top: 0, height: 300 }, { id: A2, top: 1000, height: 300 }, { id: A3, top: 2000, height: 300 }],
      { scrollTop: 2400, scrollHeight: 3000 },
    );
    render(<Harness ids={[A1, A2, A3]} prepare={prepare} />);
    expect(dots()).toHaveLength(3);
    expect(activeDotIndex()).toBe(2);
    expect(screen.queryByRole('button', { name: 'Return to the latest message' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Answers in this chat' })).toBeInTheDocument();
  });

  it('scrolling up moves the marker reply by reply and shows the return button', () => {
    const { prepare } = makePrepare(
      [{ id: A1, top: 0, height: 300 }, { id: A2, top: 1000, height: 300 }, { id: A3, top: 2000, height: 300 }],
      { scrollTop: 0, scrollHeight: 3000 },
    );
    render(<Harness ids={[A1, A2, A3]} prepare={prepare} />);
    expect(activeDotIndex()).toBe(0);
    scrollTo(1000);
    expect(activeDotIndex()).toBe(1);
    expect(screen.getByRole('button', { name: 'Return to the latest message' })).toBeVisible();
    scrollTo(2350);
    expect(activeDotIndex()).toBe(2);
    scrollTo(2400);
    expect(screen.queryByRole('button', { name: 'Return to the latest message' })).toBeNull();
  });
});

describe('explicit navigation applies one smooth jump', () => {
  it('a dot click scrolls to that reply anchor with the mock offset', () => {
    const { prepare, scrollTo: spy } = makePrepare(
      [{ id: A1, top: 0, height: 300 }, { id: A2, top: 1000, height: 300 }, { id: A3, top: 2000, height: 300 }],
      { scrollTop: 2400, scrollHeight: 3000 },
    );
    render(<Harness ids={[A1, A2, A3]} prepare={prepare} />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Go to model answer 2' })); });
    expect(spy).toHaveBeenCalledWith({ top: 1000 - 75, behavior: 'smooth' });
    // The applied intent is consumed: an identical second click scrolls again, not twice.
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Go to model answer 2' })); });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('R1: A4 owns exact-match scrolling — consumeSearch syncs from the viewport, never jumps', () => {
    const { prepare, scrollTo: spy } = makePrepare(
      [{ id: A1, top: 100, height: 3000 }, { id: A2, top: 3400, height: 400 }],
      { scrollTop: 0, viewport: 500, scrollHeight: 3900 },
    );
    render(<Harness ids={[A1, A2]} prepare={prepare} search={A1} />);
    expect(activeDotIndex()).toBe(0);

    // A4 centered its exact match at y=1900 by scrolling the log itself.
    scrollTo(1820);
    expect(activeDotIndex()).toBe(0); // a1's reply, now derived from A4's actual viewport
    const findJump = screen.getByRole('button', { name: 'find jump' });
    act(() => { fireEvent.click(findJump); });
    act(() => { fireEvent.click(findJump); }); // the next match lives in the same reply
    expect(spy).not.toHaveBeenCalled(); // no second, conflicting jump to the reply top (y=25)

    // The two actions that DO jump: a dot click to its anchor, a bare arrow to the next reply.
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Go to model answer 1' })); });
    expect(spy).toHaveBeenCalledWith({ top: 25, behavior: 'smooth' });
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowDown' }); });
    expect(spy).toHaveBeenLastCalledWith({ top: 3400 - 75, behavior: 'smooth' });
  });

  it('reduced motion lands the same jump instantly', () => {
    const { prepare, scrollTo: spy } = makePrepare(
      [{ id: A1, top: 0, height: 300 }, { id: A2, top: 1000, height: 300 }],
      { scrollTop: 0, scrollHeight: 3000 },
    );
    render(<Harness ids={[A1, A2]} prepare={prepare} reduced />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Go to model answer 2' })); });
    expect(spy).toHaveBeenCalledWith({ top: 925, behavior: 'instant' });
  });
});

describe('↑/↓ navigate answers only outside inputs', () => {
  function setup() {
    const made = makePrepare(
      [{ id: A1, top: 0, height: 300 }, { id: A2, top: 1000, height: 300 }, { id: A3, top: 2000, height: 300 }],
      { scrollTop: 1000, scrollHeight: 3000 },
    );
    const view = render(<Harness ids={[A1, A2, A3]} prepare={made.prepare} />);
    return { scrollTo: made.scrollTo, view };
  }

  it('bare keys jump to the previous/next answer', () => {
    const { scrollTo: spy } = setup();
    expect(activeDotIndex()).toBe(1); // reading a2
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowDown' }); });
    expect(spy).toHaveBeenCalledWith({ top: 2000 - 75, behavior: 'smooth' });
    // The smooth jump lands: the marker moves, and ↓ at the last answer does nothing.
    scrollTo(1925);
    expect(activeDotIndex()).toBe(2);
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowDown' }); });
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowUp' }); });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({ top: 1000 - 75, behavior: 'smooth' });
  });

  it('the next/previous handles dispatch the same navigation', () => {
    const { scrollTo: spy } = setup();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'next handle' })); });
    expect(spy).toHaveBeenCalledWith({ top: 2000 - 75, behavior: 'smooth' });
  });

  it('modifiers, other keys and fields inside the log keep their meaning', () => {
    const { scrollTo: spy } = setup();
    const field = screen.getByRole('textbox', { name: 'Fake editor' });
    act(() => { fireEvent.keyDown(field, { key: 'ArrowDown' }); });
    act(() => { fireEvent.keyDown(field, { key: 'ArrowUp' }); });
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowDown', metaKey: true }); });
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowDown', ctrlKey: true }); });
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowDown', altKey: true }); });
    act(() => { fireEvent.keyDown(log(), { key: 'Enter' }); });
    expect(spy).not.toHaveBeenCalled();
  });

  it('R1: Shift+Arrow stays the native selection — no navigation, nothing prevented', () => {
    const { scrollTo: spy } = setup();
    // dispatchEvent reports true exactly when nobody called preventDefault.
    expect(fireEvent.keyDown(log(), { key: 'ArrowDown', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(log(), { key: 'ArrowUp', shiftKey: true })).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('R1: a key event another handler already consumed is left alone', () => {
    const { scrollTo: spy } = setup();
    const parent = log().parentElement as HTMLElement;
    const consume = (event: Event) => { event.preventDefault(); };
    parent.addEventListener('keydown', consume, true); // capture: runs before the log's handlers
    try {
      expect(fireEvent.keyDown(log(), { key: 'ArrowDown' })).toBe(false); // the consumer prevented it
      expect(spy).not.toHaveBeenCalled();
    } finally {
      parent.removeEventListener('keydown', consume, true);
    }
  });

  it('wiring stage: a frozen viewport (the open find, A4, or a hidden chat) keeps the keys', () => {
    const made = makePrepare(
      [{ id: A1, top: 0, height: 300 }, { id: A2, top: 1000, height: 300 }, { id: A3, top: 2000, height: 300 }],
      { scrollTop: 1000, scrollHeight: 3000 },
    );
    const { rerender } = render(<Harness ids={[A1, A2, A3]} prepare={made.prepare} frozen />);
    const { scrollTo: spy } = made;
    expect(activeDotIndex()).toBe(1); // the marker still follows the reading position
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowDown' }); });
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowUp' }); });
    expect(spy).not.toHaveBeenCalled(); // bare arrows never jump while another surface owns the viewport
    scrollTo(1500);
    expect(activeDotIndex()).toBe(1); // scrolling still moves the marker through the freeze
    rerender(<Harness ids={[A1, A2, A3]} prepare={made.prepare} />);
    act(() => { fireEvent.keyDown(log(), { key: 'ArrowDown' }); });
    expect(spy).toHaveBeenCalledWith({ top: 2000 - 75, behavior: 'smooth' }); // unfrozen: ours again
  });
});

describe('streaming: stable ids, the user\'s place kept, explicit return to the latest', () => {
  it('a new reply gets its dot without moving the view; the return button goes to the newest', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { prepare, scrollTo: spy, growTo } = makePrepare(
      [{ id: A1, top: 0, height: 300 }, { id: A2, top: 1000, height: 300 }],
      { scrollTop: 500, scrollHeight: 3000 },
    );
    const { rerender } = render(<Harness ids={[A1, A2]} prepare={prepare} />);
    expect(dots()).toHaveLength(2);
    expect(activeDotIndex()).toBe(0); // the user is reading a1, up in the history

    // A third reply starts streaming: the list grows, the content grows with it.
    growTo(3600);
    rerender(<Harness ids={[A1, A2, A3]} prepare={prepare} />);
    stubAnchor(log(), { id: A3, top: 2000, height: 500 });
    // The mutation observer coalesces this batch to one layout read; flush it like a frame.
    await act(async () => { await Promise.resolve(); });
    expect(spy).not.toHaveBeenCalled(); // nothing pulled the user anywhere yet
    act(() => { frames.splice(0).forEach((cb) => cb(0)); });

    expect(dots()).toHaveLength(3);
    expect(activeDotIndex()).toBe(0); // ids stayed stable: a1/a2 keep their dots and place
    expect(log().scrollTop).toBe(500);
    expect(spy).not.toHaveBeenCalled(); // manual reading position preserved during streaming

    // The explicit return to the latest message, not a forced pull.
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Return to the latest message' })); });
    expect(spy).toHaveBeenLastCalledWith({ top: 3600, behavior: 'smooth' });
  });
});
