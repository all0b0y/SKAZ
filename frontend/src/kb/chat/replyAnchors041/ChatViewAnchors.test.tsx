import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatMessage } from '../../test/fakeKb';
import { chatWorld } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';

/*
 * B1 wiring — regression coverage on the SHIPPED host. renderKb mounts the whole real app
 * (real stores, real Composer, real chat list) and with it the actual production ChatView —
 * the B1-only mount this worktree ships — with no host mock: what passes here is what the
 * release branch runs. The cross-parent composition (the verified A2+A4 find/save host plus
 * B1) is proven separately in the scratch tree `.dev/b1-composed/`, against its composed host.
 * jsdom has no layout, so the conversation's geometry — the one the anchor hook measures — is
 * defined per element (R1's pattern, A4's conversationBounds pattern): content coordinates stay
 * fixed while scrollTop moves, exactly like a real scroller.
 */

const A1 = 'a1';
const A2 = 'a2';
const A3 = 'a3';
const VIEWPORT = 200;
const AT = '2026-10-15T09:00:00Z';

interface ReplySpec { id: string; top: number; height?: number }

/** A long thread: three answers with generous gaps, so every jump is a deep one. */
function longThread(third: { streaming?: boolean } = {}): KbMessageList {
  return [
    chatMessage('q1', 1, 'user', AT, [{ type: 'text', text: 'Первый вопрос?' }]),
    chatMessage(A1, 2, 'assistant', AT, [{ type: 'text', text: `Первый ответ. ${'Подробности первого ответа. '.repeat(40)}` }]),
    chatMessage('q2', 3, 'user', AT, [{ type: 'text', text: 'Второй вопрос?' }]),
    chatMessage(A2, 4, 'assistant', AT, [{ type: 'text', text: `Второй ответ. ${'Подробности второго ответа. '.repeat(40)}` }]),
    chatMessage('q3', 5, 'user', AT, [{ type: 'text', text: 'Третий вопрос?' }]),
    chatMessage(A3, 6, 'assistant', AT, [{ type: 'text', text: `Третий ответ. ${'Подробности третьего ответа. '.repeat(40)}` }],
      { state: third.streaming ? 'streaming' : 'done' }),
  ];
}
type KbMessageList = Array<ReturnType<typeof chatMessage>>;

function mount(opts: { messages?: KbMessageList; streaming?: boolean; secondChat?: boolean; motion?: 'full' | 'off' } = {}) {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const world = chatWorld();
  const chat = world.chats.find(({ id }) => id === 'c1')!;
  chat.messages = opts.messages ?? longThread({ streaming: opts.streaming });
  if (opts.streaming) chat.state = 'answering';
  if (opts.secondChat) {
    const second = world.chats.find(({ id }) => id === 'c7')!;
    second.messages = [
      chatMessage('sq1', 1, 'user', second.created_at, [{ type: 'text', text: 'Единственный вопрос?' }]),
      chatMessage('sa1', 2, 'assistant', second.created_at, [{ type: 'text', text: 'Единственный ответ с подробностями.' }]),
    ];
  }
  const rendered = renderKb({ world, prefs: { motion: opts.motion ?? 'off' } });
  return {
    ...rendered,
    frames,
    /** The anchor hook coalesces streamed mutations to one layout read per frame; flush it like one. */
    flush: () => act(() => { frames.splice(0).forEach((cb) => cb(0)); }),
    stream: (messageId: string, text: string) => {
      const worldChat = rendered.fake.world.chats.find(({ id }) => id === 'c1')!;
      rendered.fake.world.chatEvents.c1 = [{ seq: ++worldChat.cursor, type: 'delta', message_id: messageId, text }];
    },
  };
}

const log = () => screen.getByRole('log', { name: 'Conversation' });
const dots = () => screen.getAllByRole('button', { name: /Go to model answer \d+/ });
const activeDotIndex = () => dots().findIndex((d) => d.getAttribute('aria-current') === 'true');
const returnButton = () => screen.getByRole('button', { name: 'Return to the latest message' });

/** Install the conversation's geometry: content coordinates, the scroller's viewport, a recording scrollTo. */
function place(scroll: HTMLElement, replies: ReplySpec[], scrollHeight: number) {
  let height = scrollHeight;
  let top = 0;
  // Browser-true clamping: the scroller can never sit below its content (the stick-to-bottom
  // pull writes scrollHeight, which a real viewport clamps to scrollHeight − clientHeight).
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, height - VIEWPORT)); },
  });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: VIEWPORT });
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(scroll, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 300, VIEWPORT) });
  const scrollTo = vi.fn(({ top: to = scroll.scrollTop }: ScrollToOptions) => { scroll.scrollTop = to; });
  scroll.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
  for (const reply of replies) {
    const node = scroll.querySelector<HTMLElement>(`[data-message-id="${reply.id}"]`);
    if (!node) throw new Error(`no element for reply ${reply.id}`);
    Object.defineProperty(node, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, reply.top - scroll.scrollTop, 300, reply.height ?? 380),
    });
  }
  return { scrollTo, growTo: (n: number) => { height = n; } };
}

/** Move like the browser would: set the position, deliver the scroll event. */
const land = (top: number) => act(() => { log().scrollTop = top; fireEvent.scroll(log()); });

async function open(replies: ReplySpec[], scrollHeight = 1200) {
  fireEvent.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
  const scroll = log();
  await waitFor(() => expect(scroll.querySelector('[data-message-id="a1"]')).not.toBeNull());
  return place(scroll, replies, scrollHeight);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the production ChatView with the B1 reply-anchor mount', () => {
  it('mirrors the thread: a dot per answer, the marker follows the reading position', async () => {
    const view = mount();
    const geo = await open([{ id: A1, top: 140 }, { id: A2, top: 560 }, { id: A3, top: 980 }]);
    // The shipped host contract: the log is the anchor surface — marked, focusable, still a log.
    expect(log()).toHaveAttribute('data-anchors', 'true');
    expect(log()).toHaveAttribute('tabindex', '0'); // focusable with a chat open (bare ↑/↓)
    // The newest text is in view (stick): the last answer is the current one.
    land(1000);
    view.flush();
    expect(dots()).toHaveLength(3);
    expect(activeDotIndex()).toBe(2);
    expect(screen.queryByRole('button', { name: 'Return to the latest message' })).toBeNull();

    // Scrolling up moves the marker reply by reply; the return button appears.
    land(300);
    expect(activeDotIndex()).toBe(0);
    expect(returnButton()).toBeVisible();
    land(490);
    expect(activeDotIndex()).toBe(1);
    land(1000);
    expect(activeDotIndex()).toBe(2);
    expect(screen.queryByRole('button', { name: 'Return to the latest message' })).toBeNull();
    expect(geo.scrollTo).not.toHaveBeenCalled(); // following the view never jumped anywhere
  });

  it('a deep hit keeps the user\'s place through streaming, and the return button resumes following', async () => {
    const view = mount({ streaming: true });
    const geo = await open([{ id: A1, top: 140 }, { id: A2, top: 560 }, { id: A3, top: 980 }]);
    land(1000);
    view.flush();

    // The deep hit: measured before 1000, the click lands the answer's top with the mock offset.
    act(() => { fireEvent.click(dots()[0]!); });
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 140 - 75, behavior: 'instant' });
    land(65);
    expect(activeDotIndex()).toBe(0);
    expect(log().scrollTop).toBe(65); // no reset to the bottom, no second jump

    // Streamed growth leaves the user's place alone (the explicit jump, not a forced pull).
    geo.growTo(1400);
    view.stream(A3, ' Ещё текст растущего ответа.');
    await waitFor(() => expect(log().textContent).toContain('Ещё текст растущего ответа.'), { timeout: 4200 });
    view.flush();
    expect(log().scrollTop).toBe(65);
    expect(activeDotIndex()).toBe(0);
    expect(dots()).toHaveLength(3); // ids stayed stable through streaming

    // The explicit return: it lands at the newest message and following resumes on its landing.
    act(() => { fireEvent.click(returnButton()); });
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 1400, behavior: 'instant' });
    land(1400);
    geo.growTo(1500);
    view.stream(A3, ' И ещё немного.');
    await waitFor(() => expect(log().textContent).toContain('И ещё немного.'), { timeout: 4200 });
    expect(log().scrollTop).toBe(1300); // the stick follows the grown bottom again (1500 − 200)
    expect(activeDotIndex()).toBe(2);
    expect(screen.queryByRole('button', { name: 'Return to the latest message' })).toBeNull();
  }, 20000); // two long-poll delivery cycles (fake events arrive on the ~3 s poll)

  it('captures a smooth ArrowUp flight through the bottom zone without following a streamed update', async () => {
    const view = mount({ streaming: true, motion: 'full' });
    const geo = await open([{ id: A1, top: 140 }, { id: A2, top: 560 }, { id: A3, top: 980 }]);
    land(1000);
    view.flush();
    // An actual animation moves on later frames. Deliver its first scroll while still 10px from bottom.
    geo.scrollTo.mockImplementation(() => {});
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 485, behavior: 'smooth' });
    land(990);
    expect(view.services.chats.getState().getReadingAnchor('c1')).toMatchObject({ scrollTop: 990, stickToBottom: false });
    expect(log().scrollTop).toBe(990);
    geo.growTo(1400);
    view.stream(A3, ' Growth during the flight.');
    await waitFor(() => expect(log()).toHaveTextContent('Growth during the flight.'), { timeout: 5000 });
    expect(log().scrollTop).toBe(990);

    land(485);
    expect(activeDotIndex()).toBe(1);
    fireEvent.click(returnButton());
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 1400, behavior: 'smooth' });
    land(1200);
    expect(view.services.chats.getState().getReadingAnchor('c1')?.stickToBottom).toBe(true);
    geo.growTo(1500);
    view.stream(A3, ' Growth after returning.');
    await waitFor(() => expect(log()).toHaveTextContent('Growth after returning.'), { timeout: 5000 });
    expect(log().scrollTop).toBe(1300);
  }, 20000);

  it('keeps following when the chosen reply already lands at the clamped bottom', async () => {
    const view = mount({ streaming: true });
    const geo = await open([{ id: A1, top: 140 }, { id: A2, top: 560 }, { id: A3, top: 1090, height: 80 }]);
    land(1000);
    view.flush();
    fireEvent.click(dots()[2]!);
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 1015, behavior: 'instant' });
    // A no-op scroll at the clamped bottom produces no native scroll event.
    geo.growTo(1400);
    view.stream(A3, ' Longer newest reply.');
    await waitFor(() => expect(log()).toHaveTextContent('Longer newest reply.'), { timeout: 5000 });
    expect(log().scrollTop).toBe(1200);
  });

  it('follows the new bottom when a smooth Return lands at the pre-stream bottom', async () => {
    const view = mount({ streaming: true, motion: 'full' });
    const geo = await open([{ id: A1, top: 140 }, { id: A2, top: 560 }, { id: A3, top: 980 }]);
    land(485);
    view.flush();
    geo.scrollTo.mockImplementation(() => {});
    fireEvent.click(returnButton());
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'smooth' });
    land(750);

    geo.growTo(1400);
    view.stream(A3, ' Growth during Return.');
    await waitFor(() => expect(log()).toHaveTextContent('Growth during Return.'), { timeout: 5000 });
    expect(log().scrollTop).toBe(750);

    // The smooth scroll still targets the original bottom (1200 - 200).
    land(1000);
    fireEvent(log(), new Event('scrollend'));
    expect(log().scrollTop).toBe(1200);
    expect(view.services.chats.getState().getReadingAnchor('c1')).toMatchObject({ scrollTop: 1200, stickToBottom: true });
  });

  it('keeps the reader in history when a smooth Return is interrupted', async () => {
    const view = mount({ motion: 'full' });
    const geo = await open([{ id: A1, top: 140 }, { id: A2, top: 560 }, { id: A3, top: 980 }]);
    land(485);
    view.flush();
    geo.scrollTo.mockImplementation(() => {});
    fireEvent.click(returnButton());
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'smooth' });
    geo.growTo(1400);
    land(750);
    fireEvent(log(), new Event('scrollend'));
    expect(log().scrollTop).toBe(750);
    land(1000);
    fireEvent(log(), new Event('scrollend'));
    expect(log().scrollTop).toBe(1000);
    expect(view.services.chats.getState().getReadingAnchor('c1')).toMatchObject({ scrollTop: 1000, stickToBottom: false });
  });

  it('bare ↑/↓ outside fields navigate; the composer, Shift+Arrow and a hidden chat keep their keys', async () => {
    const view = mount();
    const geo = await open([{ id: A1, top: 140 }, { id: A2, top: 560 }, { id: A3, top: 980 }]);
    land(490);
    view.flush();
    expect(activeDotIndex()).toBe(1); // reading the second answer

    expect(fireEvent.keyDown(log(), { key: 'ArrowDown' })).toBe(false); // ours, prevented
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 980 - 75, behavior: 'instant' });
    land(905);
    expect(activeDotIndex()).toBe(2);
    expect(fireEvent.keyDown(log(), { key: 'ArrowDown' })).toBe(false); // at the last answer: nothing past it
    expect(fireEvent.keyDown(log(), { key: 'ArrowUp' })).toBe(false);
    expect(geo.scrollTo).toHaveBeenLastCalledWith({ top: 560 - 75, behavior: 'instant' });
    land(485);
    expect(activeDotIndex()).toBe(1);
    const jumps = geo.scrollTo.mock.calls.length;

    // The composer keeps its arrows: its field lives outside the log, the guard never sees them.
    const field = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(geo.scrollTo).toHaveBeenCalledTimes(jumps);

    // Shift+Arrow is the native selection: not ours, never prevented.
    expect(fireEvent.keyDown(log(), { key: 'ArrowDown', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(log(), { key: 'ArrowUp', shiftKey: true })).toBe(true);
    expect(geo.scrollTo).toHaveBeenCalledTimes(jumps);

    // A hidden chat pane owns nothing: the keys stay with the page until it is visible again.
    const scroll = log(); // getByRole cannot see a hidden log — keep the element, not the query.
    act(() => view.services.ui.getState().showCenter('allChats'));
    fireEvent.keyDown(scroll, { key: 'ArrowDown' });
    expect(geo.scrollTo).toHaveBeenCalledTimes(jumps);
    act(() => view.services.ui.getState().showCenter('chat'));
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(geo.scrollTo).toHaveBeenCalledTimes(jumps + 1);
  });

  it('switching chats resets the rail and the stick without a stale flight', async () => {
    const view = mount({ secondChat: true });
    const geo = await open([{ id: A1, top: 140 }, { id: A2, top: 560 }, { id: A3, top: 980 }]);
    land(1000);
    view.flush();
    act(() => { fireEvent.click(dots()[0]!); }); // a flight the switch must cancel cleanly
    land(65);
    expect(activeDotIndex()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /Seminar questions/ }));
    const second = log();
    await waitFor(() => expect(second.querySelector('[data-message-id="sa1"]')).not.toBeNull());
    const geo2 = place(second, [{ id: 'sa1', top: 140 }], 1200);
    view.flush();
    await waitFor(() => {
      expect(dots()).toHaveLength(1); // the new chat's answers, nothing of the old thread
      expect(activeDotIndex()).toBe(0);
      expect(second.scrollTop).toBe(1000); // stick reset: the newest text in view again (1200 − 200)
    });
    fireEvent.keyDown(second, { key: 'ArrowDown' }); // at the only answer: nothing past it
    expect(geo.scrollTo).toHaveBeenCalledTimes(1); // the old flight's landing, nothing since
    expect(geo2.scrollTo).not.toHaveBeenCalled();
  });
});
