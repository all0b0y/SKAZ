import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import {
  captureReadingAnchor,
  createAnchorScope,
  restoreReadingAnchor,
  type ReadingAnchor,
} from './readingAnchor';
import { createChatTabsStore } from './tabsStore';
import { useScopedReadingAnchor } from './useScopedReadingAnchor';

function stubRect(el: HTMLElement, top: number, height: number) {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 400,
      width: 400,
      height,
      x: 0,
      y: top,
      toJSON() {},
    }) as DOMRect;
}

function makeScrollContainer(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  el.scrollTop = scrollTop;
  stubRect(el, 100, clientHeight);
  return el;
}

function addMsg(container: HTMLElement, id: string, docTop: number, height: number) {
  const msg = document.createElement('div');
  msg.setAttribute('data-message-id', id);
  // Layout top relative to container viewport = 100 + docTop - container.scrollTop
  msg.getBoundingClientRect = () => {
    const top = 100 + docTop - container.scrollTop;
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 360,
      width: 360,
      height,
      x: 0,
      y: top,
      toJSON() {},
    } as DOMRect;
  };
  container.appendChild(msg);
  return msg;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('captureReadingAnchor & restoreReadingAnchor', () => {
  it('captures strictly within the scoped container and ignores messages in other panes', () => {
    const outside = document.createElement('div');
    const foreignMsg = document.createElement('div');
    foreignMsg.setAttribute('data-message-id', 'foreign-msg');
    stubRect(foreignMsg, 110, 80);
    outside.appendChild(foreignMsg);

    const container = makeScrollContainer(150, 1200, 400);
    addMsg(container, 'm1', 0, 120);
    addMsg(container, 'm2', 120, 220);
    addMsg(container, 'm3', 340, 300);

    document.body.append(outside, container);

    const anchor = captureReadingAnchor(container, { now: () => 42 });
    expect(anchor).toEqual({
      messageId: 'm2',
      offsetPx: -30,
      scrollTop: 150,
      stickToBottom: false,
      updatedAt: 42,
    });
  });

  it('restores by message anchor across layout reflow before falling back to scrollTop', () => {
    const container = makeScrollContainer(150, 1200, 400);
    addMsg(container, 'm1', 0, 120);
    addMsg(container, 'm2', 120, 220);
    addMsg(container, 'm3', 340, 300);

    const anchor = captureReadingAnchor(container)!;
    expect(anchor.messageId).toBe('m2');
    expect(anchor.offsetPx).toBe(-30);

    // Simulate earlier message m1 growing by +90px after reflow while user was on another tab.
    const reflowed = makeScrollContainer(0, 1290, 400);
    addMsg(reflowed, 'm1', 0, 210);
    addMsg(reflowed, 'm2', 210, 220);
    addMsg(reflowed, 'm3', 430, 300);

    const res = restoreReadingAnchor(reflowed, anchor);
    expect(res).toEqual({
      restored: true,
      mode: 'anchor',
      scrollTop: 240,
      stickToBottom: false,
      messageId: 'm2',
    });
    expect(reflowed.scrollTop).toBe(240);
  });

  it('falls back to clamped scrollTop when the anchored message is no longer present', () => {
    const container = makeScrollContainer(0, 600, 400);
    addMsg(container, 'm1', 0, 100);
    const anchor: ReadingAnchor = {
      messageId: 'deleted-m2',
      offsetPx: -12,
      scrollTop: 350,
      stickToBottom: false,
      updatedAt: 1,
    };

    const res = restoreReadingAnchor(container, anchor);
    expect(res).toEqual({
      restored: true,
      mode: 'position',
      scrollTop: 200,
      stickToBottom: false,
      messageId: null,
    });
    expect(container.scrollTop).toBe(200);
  });

  it('restores stickToBottom at the current scrollHeight when user was at the bottom', () => {
    const container = makeScrollContainer(790, 1200, 400);
    addMsg(container, 'm1', 0, 1200);
    const anchor = captureReadingAnchor(container)!;
    expect(anchor.stickToBottom).toBe(true);

    // New streamed text arrived in the background, increasing scrollHeight to 1600.
    const grown = makeScrollContainer(0, 1600, 400);
    addMsg(grown, 'm1', 0, 1600);

    const res = restoreReadingAnchor(grown, anchor);
    expect(res.mode).toBe('bottom');
    expect(res.stickToBottom).toBe(true);
    expect(res.scrollTop).toBe(1200);
    expect(grown.scrollTop).toBe(1200);
  });

  it('aborts stale scoped restores when a later tab claim supersedes the token', () => {
    const scope = createAnchorScope();
    const container = makeScrollContainer(0, 1200, 400);
    const t1 = scope.claim('c1');
    const t2 = scope.claim('c2');

    expect(scope.isCurrent('c1', t1)).toBe(false);
    expect(scope.isCurrent('c2', t2)).toBe(true);

    const stale = scope.restoreIfCurrent('c1', t1, container, {
      messageId: null,
      offsetPx: 0,
      scrollTop: 500,
      stickToBottom: false,
      updatedAt: 1,
    });
    expect(stale).toBeNull();
    expect(container.scrollTop).toBe(0);

    expect(scope.captureIfCurrent('c1', t1, container)).toBeNull();
    expect(scope.captureIfCurrent('c2', t2, container)).not.toBeNull();

    scope.clear();
    expect(scope.isCurrent('c2', t2)).toBe(false);
    expect(scope.captureIfCurrent('c2', t2, container)).toBeNull();
  });
});

describe('useScopedReadingAnchor', () => {
  function Harness({ store }: { store: ReturnType<typeof createChatTabsStore> }) {
    const [chatId, setChatId] = useState<string | null>('c1');
    const [ready, setReady] = useState(true);
    const [hidden, setHidden] = useState(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const stickRef = useRef(true);

    const handle = useScopedReadingAnchor({
      chatId,
      scrollRef,
      ready,
      hidden,
      stickRef,
      getAnchor: (id) => store.getState().getAnchor(id),
      setAnchor: (id, a) => store.getState().setAnchor(id, a),
    });

    return (
      <div>
        <button
          type="button"
          onClick={() => {
            handle.captureNow();
            setChatId('c2');
          }}
        >
          to-c2
        </button>
        <button
          type="button"
          onClick={() => {
            handle.captureNow();
            setChatId('c1');
          }}
        >
          to-c1
        </button>
        <button type="button" onClick={() => setReady((v) => !v)}>
          toggle-ready
        </button>
        <button type="button" onClick={() => setHidden((v) => !v)}>
          toggle-hidden
        </button>
        <div
          ref={(el) => {
            scrollRef.current = el;
            if (el) {
              Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 });
              Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 });
            }
          }}
          data-testid="scroller"
        >
          {ready && (
            <>
              <div data-message-id={`${chatId}-m1`} />
              <div data-message-id={`${chatId}-m2`} />
            </>
          )}
        </div>
      </div>
    );
  }

  it('preserves per-chat scroll positions across switches and never zeroes anchors while hidden or loading', () => {
    const store = createChatTabsStore({ openIds: ['c1', 'c2'], activeId: 'c1' });
    render(<Harness store={store} />);
    const scroller = screen.getByTestId('scroller');

    // Initial visit to c1 defaults to bottom (1000 - 300 = 700).
    expect(scroller.scrollTop).toBe(700);

    // User scrolls up inside c1.
    scroller.scrollTop = 215;
    fireEvent.scroll(scroller);
    expect(store.getState().getAnchor('c1')?.scrollTop).toBe(215);
    expect(store.getState().getAnchor('c1')?.stickToBottom).toBe(false);

    // Switch to c2 -> c2 defaults to bottom (700).
    fireEvent.click(screen.getByText('to-c2'));
    expect(scroller.scrollTop).toBe(700);

    // Scroll c2 up to 95.
    scroller.scrollTop = 95;
    fireEvent.scroll(scroller);
    expect(store.getState().getAnchor('c2')?.scrollTop).toBe(95);

    // Hide pane (e.g. All materials) and emit a zero scroll event: saved anchor must stay 95.
    fireEvent.click(screen.getByText('toggle-hidden'));
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(store.getState().getAnchor('c2')?.scrollTop).toBe(95);

    // Reveal pane: c2's 95px position is restored.
    fireEvent.click(screen.getByText('toggle-hidden'));
    expect(scroller.scrollTop).toBe(95);

    // Switch back to c1 while simulating loading -> ready transition.
    act(() => {
      fireEvent.click(screen.getByText('toggle-ready'));
    });
    fireEvent.click(screen.getByText('to-c1'));
    expect(store.getState().getAnchor('c1')?.scrollTop).toBe(215);

    fireEvent.click(screen.getByText('toggle-ready'));
    expect(scroller.scrollTop).toBe(215);
  });

  it('ignores delayed stale chat/scope captures across switches and rapid A->B->A transitions while preserving separate anchors', () => {
    const store = createChatTabsStore({ openIds: ['c1', 'c2'], activeId: 'c1' });
    const container = makeScrollContainer(0, 1200, 400);
    const scrollRef = { current: container as HTMLElement | null };
    const stickRef = { current: true };

    const mountMessages = (chatId: string) => {
      container.innerHTML = '';
      addMsg(container, `${chatId}-m1`, 0, 120);
      addMsg(container, `${chatId}-m2`, 120, 260);
      addMsg(container, `${chatId}-m3`, 380, 320);
      addMsg(container, `${chatId}-m4`, 700, 500);
    };

    mountMessages('c1');

    const { result, rerender } = renderHook(
      (props: { chatId: string | null; ready: boolean; hidden?: boolean }) =>
        useScopedReadingAnchor({
          chatId: props.chatId,
          scrollRef,
          ready: props.ready,
          hidden: props.hidden,
          stickRef,
          getAnchor: (id) => store.getState().getAnchor(id),
          setAnchor: (id, a) => store.getState().setAnchor(id, a),
        }),
      { initialProps: { chatId: 'c1' as string | null, ready: true, hidden: false } },
    );

    // c1 starts at bottom (800). Scroll up to 180 (c1-m2 at -60px) and capture pre-switch.
    expect(container.scrollTop).toBe(800);
    container.scrollTop = 180;
    const staleC1Visit1Capture = result.current.captureNow;
    const preSwitchC1 = result.current.captureNow('c1');
    expect(preSwitchC1).toMatchObject({
      messageId: 'c1-m2',
      offsetPx: -60,
      scrollTop: 180,
      stickToBottom: false,
    });
    expect(stickRef.current).toBe(false);

    // Switch c1 -> c2 with separate messages and scroll position.
    mountMessages('c2');
    rerender({ chatId: 'c2', ready: true, hidden: false });
    expect(container.scrollTop).toBe(800);

    container.scrollTop = 420;
    const preSwitchC2 = result.current.captureNow();
    expect(preSwitchC2).toMatchObject({
      messageId: 'c2-m3',
      offsetPx: -40,
      scrollTop: 420,
      stickToBottom: false,
    });

    // Delayed capture attempts for previous tab c1 must be ignored and never overwrite c1 or c2.
    expect(result.current.captureNow('c1')).toBeNull();
    expect(staleC1Visit1Capture()).toBeNull();
    expect(staleC1Visit1Capture('c1')).toBeNull();
    expect(store.getState().getAnchor('c1')).toMatchObject({
      messageId: 'c1-m2',
      offsetPx: -60,
      scrollTop: 180,
    });
    expect(store.getState().getAnchor('c2')).toMatchObject({
      messageId: 'c2-m3',
      offsetPx: -40,
      scrollTop: 420,
    });

    // Rapid A -> B -> A back to c1 restores c1's separate anchor.
    mountMessages('c1');
    rerender({ chatId: 'c1', ready: true, hidden: false });
    expect(container.scrollTop).toBe(180);

    // Scroll c1 during visit 2; stale visit-1 closure must still be ignored even though chatId is 'c1' again.
    container.scrollTop = 260;
    expect(result.current.captureNow('c1')).toMatchObject({
      messageId: 'c1-m2',
      offsetPx: -140,
      scrollTop: 260,
    });
    expect(staleC1Visit1Capture()).toBeNull();
    expect(staleC1Visit1Capture('c1')).toBeNull();
    expect(store.getState().getAnchor('c1')).toMatchObject({
      messageId: 'c1-m2',
      offsetPx: -140,
      scrollTop: 260,
    });

    // Rapid A -> B -> A with loading/hidden states preserves both separate anchors and rejects captures while inactive.
    mountMessages('c2');
    rerender({ chatId: 'c2', ready: false, hidden: false });
    container.scrollTop = 0;
    expect(result.current.captureNow()).toBeNull();
    expect(result.current.captureNow('c2')).toBeNull();

    rerender({ chatId: 'c2', ready: true, hidden: true });
    expect(result.current.captureNow()).toBeNull();

    rerender({ chatId: 'c2', ready: true, hidden: false });
    expect(container.scrollTop).toBe(420);

    mountMessages('c1');
    rerender({ chatId: 'c1', ready: true, hidden: false });
    expect(container.scrollTop).toBe(260);
    expect(store.getState().getAnchor('c2')).toMatchObject({
      messageId: 'c2-m3',
      offsetPx: -40,
      scrollTop: 420,
    });
  });

  it('pauses capture without overwriting or restoring on resume when pauseCapture is toggled', () => {
    const store = createChatTabsStore({ openIds: ['c1'], activeId: 'c1' });
    const container = makeScrollContainer(0, 1200, 400);
    addMsg(container, 'm1', 0, 200);
    addMsg(container, 'm2', 200, 300);
    addMsg(container, 'm3', 500, 700);
    const scrollRef = { current: container as HTMLElement | null };

    const { result, rerender } = renderHook(
      (props: { pauseCapture: boolean }) =>
        useScopedReadingAnchor({
          chatId: 'c1',
          scrollRef,
          ready: true,
          pauseCapture: props.pauseCapture,
          getAnchor: (id) => store.getState().getAnchor(id),
          setAnchor: (id, a) => store.getState().setAnchor(id, a),
        }),
      { initialProps: { pauseCapture: false } },
    );

    container.scrollTop = 260;
    fireEvent.scroll(container);
    expect(store.getState().getAnchor('c1')?.scrollTop).toBe(260);

    // While paused (e.g. A4 find owns the viewport), scroll events and captureNow do not overwrite 260.
    rerender({ pauseCapture: true });
    container.scrollTop = 50;
    fireEvent.scroll(container);
    expect(result.current.captureNow('c1')).toBeNull();
    expect(store.getState().getAnchor('c1')?.scrollTop).toBe(260);

    // Resuming capture does not overwrite the caller's restored scrollTop.
    container.scrollTop = 260;
    rerender({ pauseCapture: false });
    expect(container.scrollTop).toBe(260);
  });
});
