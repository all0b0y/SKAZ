import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatMessage } from '../../test/fakeKb';
import { chatWorld } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';

const AT = '2026-10-15T09:00:00Z';

function longMessages(prefix: string, count = 4) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    out.push(
      chatMessage(`${prefix}-u${i}`, i * 2 - 1, 'user', AT, [{ type: 'text', text: `${prefix} question ${i}` }]),
      chatMessage(`${prefix}-a${i}`, i * 2, 'assistant', AT, [
        { type: 'text', text: `${prefix} answer ${i}. ${'Details '.repeat(25)}` },
      ]),
    );
  }
  return out;
}

function installLayout(scroll: HTMLElement, boxMap: Record<string, { top: number; height: number }>, initialHeight = 1300) {
  let height = initialHeight;
  let currentTop = scroll.scrollTop;
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 240 });
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => currentTop,
    set: (v: number) => {
      currentTop = Math.max(0, Math.min(v, Math.max(0, height - 240)));
    },
  });
  Object.defineProperty(scroll, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(0, 0, 400, 240),
  });
  const origRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === scroll) return new DOMRect(0, 0, 400, 240);
    const id = this.getAttribute?.('data-message-id');
    if (id && boxMap[id]) {
      const b = boxMap[id]!;
      return new DOMRect(0, b.top - currentTop, 380, b.height);
    }
    return origRect.call(this);
  });
  return {
    setHeight: (nextHeight: number) => {
      height = nextHeight;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Chat tabs mounted in the production Shell & ChatView', () => {
  it('opens tabs without duplication, supports keyboard nav, closes inactive/active/last and reopens with hidden sidebar', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const { services } = renderKb({ world });

    const side = screen.getByRole('region', { name: 'Chats' });
    const c1Btn = await within(side).findByRole('button', { name: /Why is there a logarithm/ });
    const c6Btn = within(side).getByRole('button', { name: /Transformer paper review/ });
    const c7Btn = within(side).getByRole('button', { name: /Seminar questions/ });

    // Open three chats -> 3 tabs, no duplication on re-click, still a single composer.
    await user.click(c1Btn);
    await user.click(c6Btn);
    await user.click(c7Btn);
    await user.click(c1Btn);

    const tablist = screen.getByRole('tablist', { name: 'Open chats' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(3);
    expect(screen.getAllByTestId('composer')).toHaveLength(1);

    // Permanently visible non-nested close buttons with exact tooltip/aria-label.
    const closeC6 = screen.getByRole('button', { name: 'Close tab: Transformer paper review' });
    expect(closeC6).toHaveAttribute('title', 'Close tab — chat stays in the list');
    expect(closeC6.closest('[role="tab"]')).toBeNull();

    // Keyboard navigation across tabs: c1 -> ArrowRight -> c6 -> End -> c7 -> Home -> c1.
    const tabC1 = within(tablist).getByRole('tab', { name: /Why is there a logarithm/ });
    const tabC6 = within(tablist).getByRole('tab', { name: /Transformer paper review/ });
    const tabC7 = within(tablist).getByRole('tab', { name: /Seminar questions/ });
    tabC1.focus();
    await user.keyboard('{ArrowRight}');
    expect(tabC6).toHaveFocus();
    expect(services.chats.getState().currentId).toBe('c6');
    await user.keyboard('{End}');
    expect(tabC7).toHaveFocus();
    expect(services.chats.getState().currentId).toBe('c7');
    await user.keyboard('{Home}');
    expect(tabC1).toHaveFocus();
    expect(services.chats.getState().currentId).toBe('c1');

    // Close inactive tab c7 while c1 is active -> c1 stays active.
    await user.click(screen.getByRole('button', { name: 'Close tab: Seminar questions' }));
    expect(services.chats.getState().currentId).toBe('c1');
    expect(within(tablist).getAllByRole('tab')).toHaveLength(2);

    // Reopen c7 from list then close active middle tab c6 -> selects right neighbour c7.
    await user.click(c7Btn);
    await user.click(tabC6);
    expect(services.chats.getState().currentId).toBe('c6');
    await user.click(screen.getByRole('button', { name: 'Close tab: Transformer paper review' }));
    expect(services.chats.getState().currentId).toBe('c7');

    // Close right-most active tab c7 -> selects left neighbour c1.
    await user.click(screen.getByRole('button', { name: 'Close tab: Seminar questions' }));
    expect(services.chats.getState().currentId).toBe('c1');

    // Collapse side panel, then close the last tab c1 -> No open chats + focused Reopen last chat.
    await user.click(screen.getByRole('button', { name: 'Hide side panel' }));
    expect(screen.queryByRole('region', { name: 'Chats' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close tab: Why is there a logarithm in the loss?' }));
    expect(screen.getByTestId('chat-tab-strip')).toHaveTextContent('No open chats');
    expect(screen.getByRole('region', { name: 'No open chats' })).toBeInTheDocument();
    const reopen = screen.getByRole('button', { name: 'Reopen last chat' });
    expect(reopen).toHaveFocus();
    expect(screen.getAllByTestId('composer')).toHaveLength(1);

    // Reopen last chat even with hidden sidebar -> c1 returns without deleting or duplicating.
    await user.click(reopen);
    expect(services.chats.getState().currentId).toBe('c1');
    expect(within(screen.getByRole('tablist', { name: 'Open chats' })).getAllByRole('tab')).toHaveLength(1);
  });

  it('preserves distinct per-chat reading positions across A->B->A, hidden pane, deletion fallback, and late data', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const c1 = world.chats.find((c) => c.id === 'c1')!;
    const c6 = world.chats.find((c) => c.id === 'c6')!;
    const c7 = world.chats.find((c) => c.id === 'c7')!;
    c1.messages = longMessages('c1', 4);
    c6.messages = longMessages('c6', 4);
    c7.messages = longMessages('c7', 4);

    let resolveLateC7: (() => void) | null = null;
    const { fake, services } = renderKb({ world });
    const origRequest = fake.bridge.request;
    fake.bridge.request = async (req) => {
      if (req.method === 'GET' && req.path === '/kb/chats/c7') {
        await new Promise<void>((resolve) => {
          resolveLateC7 = resolve;
        });
      }
      return origRequest(req);
    };

    const side = screen.getByRole('region', { name: 'Chats' });
    await user.click(await within(side).findByRole('button', { name: /Why is there a logarithm/ }));
    const scroll = screen.getByRole('log', { name: 'Conversation' });
    await waitFor(() => expect(scroll.querySelector('[data-message-id="c1-a4"]')).not.toBeNull());

    const boxMap: Record<string, { top: number; height: number }> = {
      'c1-a1': { top: 100, height: 220 },
      'c1-a2': { top: 380, height: 220 },
      'c1-a3': { top: 660, height: 220 },
      'c1-a4': { top: 940, height: 260 },
      'c6-a1': { top: 100, height: 220 },
      'c6-a2': { top: 380, height: 220 },
      'c6-a3': { top: 660, height: 220 },
      'c6-a4': { top: 940, height: 260 },
    };
    const layout = installLayout(scroll, boxMap, 1300);

    // c1 starts at bottom (1060). Scroll up to 410 (anchored to c1-a2 at -30px).
    act(() => {
      scroll.scrollTop = 410;
      fireEvent.scroll(scroll);
    });
    expect(services.chats.getState().getReadingAnchor('c1')).toMatchObject({
      messageId: 'c1-a2',
      offsetPx: -30,
      scrollTop: 410,
      stickToBottom: false,
    });

    // Switch to c6 and scroll to a distinct position (190).
    await user.click(within(side).getByRole('button', { name: /Transformer paper review/ }));
    await waitFor(() => expect(scroll.querySelector('[data-message-id="c6-a4"]')).not.toBeNull());
    act(() => {
      scroll.scrollTop = 190;
      fireEvent.scroll(scroll);
    });
    expect(services.chats.getState().getReadingAnchor('c6')?.scrollTop).toBe(190);

    // Hide chat pane via All materials, emit a zeroed scroll event, then return -> c6 stays at 190.
    act(() => services.ui.getState().showCenter('materials'));
    act(() => {
      scroll.scrollTop = 0;
      fireEvent.scroll(scroll);
    });
    expect(services.chats.getState().getReadingAnchor('c6')?.scrollTop).toBe(190);
    act(() => services.ui.getState().showCenter('chat'));
    expect(scroll.scrollTop).toBe(190);

    // Trigger late load for c7, immediately switch back to c1 before c7 resolves, then resolve c7 late.
    await user.click(within(side).getByRole('button', { name: /Seminar questions/ }));
    expect(services.chats.getState().currentId).toBe('c7');
    await waitFor(() => expect(resolveLateC7).not.toBeNull());

    // Switch back to c1 while c7 is still loading: c1 restores 410; simulate reflow of c1-a1 (+50px) -> c1-a2 stays at -30px (scrollTop 460)!
    boxMap['c1-a1'] = { top: 100, height: 270 };
    boxMap['c1-a2'] = { top: 430, height: 220 };
    layout.setHeight(1350);
    await user.click(screen.getByRole('tab', { name: /Why is there a logarithm/ }));
    await waitFor(() => expect(scroll.querySelector('[data-message-id="c1-a2"]')).not.toBeNull());
    expect(scroll.scrollTop).toBe(460);

    act(() => {
      // Late resolution of c7 arrives while user is viewing c1 -> must not touch c1's reading position.
      resolveLateC7?.();
    });
    await waitFor(() => expect(services.chats.getState().chats.c7?.load).toBe('ready'));
    expect(services.chats.getState().currentId).toBe('c1');
    expect(scroll.scrollTop).toBe(460);

    // Delete anchored message c1-a2 while away on c6, then return to c1 -> falls back to clamped scrollTop (460).
    await user.click(screen.getByRole('tab', { name: /Transformer paper review/ }));
    await waitFor(() => expect(scroll.querySelector('[data-message-id="c6-a1"]')).not.toBeNull());
    expect(scroll.scrollTop).toBe(190);
    act(() => {
      const existing = services.chats.getState().chats.c1!.chat!;
      services.chats.setState((s) => ({
        chats: {
          ...s.chats,
          c1: {
            ...s.chats.c1!,
            chat: { ...existing, messages: existing.messages.filter((m) => m.id !== 'c1-a2') },
          },
        },
      }));
    });
    await user.click(screen.getByRole('tab', { name: /Why is there a logarithm/ }));
    await waitFor(() => expect(scroll.querySelector('[data-message-id="c1-a2"]')).toBeNull());
    expect(scroll.scrollTop).toBe(460);
  });

  it('keeps an inactive streaming chat running without stopping or cancelling it when switching or closing its tab', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const c2 = world.chats.find((c) => c.id === 'c2')!;
    c2.messages = [
      chatMessage('c2-u1', 1, 'user', AT, [{ type: 'text', text: 'What happened?' }]),
      chatMessage('c2-a1', 2, 'assistant', AT, [{ type: 'text', text: 'Working...' }], { state: 'streaming' }),
    ];
    const { fake, services } = renderKb({ world });

    const side = screen.getByRole('region', { name: 'Chats' });
    await user.click(await within(side).findByRole('button', { name: /What did I miss in lecture 8/ }));
    await user.click(within(side).getByRole('button', { name: /Why is there a logarithm/ }));

    // c2 tab stays marked as working and no stop/delete call was sent.
    const c2Tab = screen.getByRole('tab', { name: /What did I miss in lecture 8/ });
    expect(within(c2Tab).getByLabelText('Working')).toBeInTheDocument();
    expect(fake.calls.some((c) => c.path.includes('/stop') || c.method === 'DELETE')).toBe(false);

    // Background delta arrives on fake backend while c2 is inactive; close c2 tab then reopen it.
    const fakeC2 = fake.world.chats.find((c) => c.id === 'c2')!;
    fake.world.chatEvents.c2 = [{ seq: ++fakeC2.cursor, type: 'delta', message_id: 'c2-a1', text: ' Finished thought.' }];
    await user.click(screen.getByRole('button', { name: 'Close tab: What did I miss in lecture 8' }));
    expect(fake.calls.some((c) => c.path.includes('/stop') || c.method === 'DELETE')).toBe(false);

    await user.click(within(side).getByRole('button', { name: /What did I miss in lecture 8/ }));
    await waitFor(() => expect(screen.getByRole('log', { name: 'Conversation' })).toHaveTextContent('Finished thought.'), {
      timeout: 4500,
    });
    expect(services.chats.getState().currentId).toBe('c2');
  }, 15000);

  it('keeps open tabs intact when starting New chat and preserves reading anchor across ongoing streamed growth', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const c1 = world.chats.find((c) => c.id === 'c1')!;
    const c2 = world.chats.find((c) => c.id === 'c2')!;
    c1.messages = longMessages('c1', 4);
    c2.messages = [
      chatMessage('c2-u1', 1, 'user', AT, [{ type: 'text', text: 'First question?' }]),
      chatMessage('c2-a1', 2, 'assistant', AT, [{ type: 'text', text: `Long intro. ${'More '.repeat(30)}` }]),
      chatMessage('c2-u2', 3, 'user', AT, [{ type: 'text', text: 'Second question?' }]),
      chatMessage('c2-a2', 4, 'assistant', AT, [{ type: 'text', text: 'Streaming start' }], { state: 'streaming' }),
    ];
    const { fake, services } = renderKb({ world });

    const side = screen.getByRole('region', { name: 'Chats' });
    await user.click(await within(side).findByRole('button', { name: /Why is there a logarithm/ }));
    await user.click(within(side).getByRole('button', { name: /What did I miss in lecture 8/ }));

    const scroll = screen.getByRole('log', { name: 'Conversation' });
    await waitFor(() => expect(scroll.querySelector('[data-message-id="c2-a2"]')).not.toBeNull());
    const layout = installLayout(
      scroll,
      {
        'c2-a1': { top: 100, height: 320 },
        'c2-a2': { top: 460, height: 300 },
      },
      900,
    );

    // User reads higher up in c2 (at 140px) while c2-a2 is still streaming.
    act(() => {
      scroll.scrollTop = 140;
      fireEvent.scroll(scroll);
    });
    expect(services.chats.getState().getReadingAnchor('c2')).toMatchObject({
      messageId: 'c2-a1',
      offsetPx: -40,
      scrollTop: 140,
      stickToBottom: false,
    });

    // Click New chat -> open tabs stay in the tab strip while composer switches to New chat.
    await user.click(within(side).getByRole('button', { name: 'New chat' }));
    expect(services.chats.getState().currentId).toBeNull();
    expect(within(screen.getByRole('tablist', { name: 'Open chats' })).getAllByRole('tab')).toHaveLength(2);

    // Switch back to c2; streamed delta arrives and grows c2-a2 at the bottom -> reading position stays at 140!
    await user.click(screen.getByRole('tab', { name: /What did I miss in lecture 8/ }));
    expect(scroll.scrollTop).toBe(140);

    const fakeC2 = fake.world.chats.find((c) => c.id === 'c2')!;
    fake.world.chatEvents.c2 = [{ seq: ++fakeC2.cursor, type: 'delta', message_id: 'c2-a2', text: ' and much more streamed text.' }];
    layout.setHeight(1400);
    await waitFor(() => expect(scroll).toHaveTextContent('and much more streamed text.'), { timeout: 4500 });
    expect(scroll.scrollTop).toBe(140);
  }, 15000);

  it('updates inactive tab & overflow indicators from list events without reopening, and protects active streams from stale summaries', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const c2 = world.chats.find((c) => c.id === 'c2')!;
    const c6 = world.chats.find((c) => c.id === 'c6')!;
    c2.messages = [
      chatMessage('c2-u1', 1, 'user', AT, [{ type: 'text', text: 'What happened?' }]),
      chatMessage('c2-a1', 2, 'assistant', AT, [{ type: 'text', text: 'Working...' }], { state: 'streaming' }),
    ];
    c6.messages = longMessages('c6', 4);
    const { fake, services } = renderKb({ world });

    // Open c2 while streaming (caches streaming message detail), then switch to c6 and scroll c6 to 120px.
    const side = screen.getByRole('region', { name: 'Chats' });
    await user.click(await within(side).findByRole('button', { name: /What did I miss in lecture 8/ }));
    const scroll = screen.getByRole('log', { name: 'Conversation' });
    await waitFor(() => expect(scroll.querySelector('[data-message-id="c2-a1"]')).not.toBeNull());

    await user.click(within(side).getByRole('button', { name: /Transformer paper review/ }));
    await waitFor(() => expect(scroll.querySelector('[data-message-id="c6-a4"]')).not.toBeNull());
    installLayout(scroll, {
      'c6-a1': { top: 100, height: 220 },
      'c6-a2': { top: 380, height: 220 },
      'c6-a3': { top: 660, height: 220 },
      'c6-a4': { top: 940, height: 260 },
    }, 1300);
    act(() => {
      scroll.scrollTop = 120;
      fireEvent.scroll(scroll);
    });
    expect(services.chats.getState().getReadingAnchor('c6')?.scrollTop).toBe(120);

    // Enable horizontal overflow on the real rendered tablist to check the shared overflow menu indicator too.
    const tablist = screen.getByRole('tablist', { name: 'Open chats' });
    Object.defineProperty(tablist, 'clientWidth', { configurable: true, value: 220 });
    Object.defineProperty(tablist, 'scrollWidth', { configurable: true, value: 600 });
    fireEvent.scroll(tablist);
    const overflow = await screen.findByTestId('chat-tabs-overflow');

    const c2Tab = within(tablist).getByRole('tab', { name: /What did I miss in lecture 8/ });
    expect(within(c2Tab).getByLabelText('Working')).toBeInTheDocument();

    // 1. Emit completed/unread summary for inactive c2 on list transport only (cached message remains 'streaming').
    const pushListSummary = (chatId: string, patch: Partial<typeof c2> & { waiting_for_user?: boolean }) => {
      const prev = services.chats.getState().list.find((c) => c.id === chatId)!;
      const seq = ++fake.world.listCursor;
      fake.world.listChanges.push({ seq, chat: { ...prev, ...patch } });
      return seq;
    };

    const doneSeq = pushListSummary('c2', { state: 'idle', unread: true, waiting_for_user: false });
    await waitFor(() => expect(services.chats.getState().listCursor).toBeGreaterThanOrEqual(doneSeq), { timeout: 6000 });

    expect(within(c2Tab).queryByLabelText('Working')).toBeNull();
    expect(within(c2Tab).getByLabelText('New answer')).toBeInTheDocument();
    expect(services.chats.getState().currentId).toBe('c6');
    expect(services.chats.getState().list.find((c) => c.id === 'c2')?.unread).toBe(true);
    expect(services.chats.getState().getReadingAnchor('c6')?.scrollTop).toBe(120);

    await user.click(within(overflow).getByRole('button', { name: 'Open tabs' }));
    const menu1 = screen.getByRole('menu', { name: 'Open tabs' });
    expect(within(within(menu1).getByRole('menuitem', { name: /What did I miss in lecture 8/ })).getByText('New')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // 2. Emit waiting_for_user transition (even while backend reports state='answering') -> Waiting takes priority.
    const waitSeq = pushListSummary('c2', { state: 'answering', waiting_for_user: true, unread: false });
    await waitFor(() => expect(services.chats.getState().listCursor).toBeGreaterThanOrEqual(waitSeq), { timeout: 6000 });

    expect(within(c2Tab).getByLabelText('Waiting for you')).toBeInTheDocument();
    expect(within(c2Tab).queryByLabelText('Working')).toBeNull();

    await user.click(within(overflow).getByRole('button', { name: 'Open tabs' }));
    const menu2 = screen.getByRole('menu', { name: 'Open tabs' });
    expect(within(within(menu2).getByRole('menuitem', { name: /What did I miss in lecture 8/ })).getByText('Waiting')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // 3. Active-stream case: c6 starts streaming via composer; a stale idle summary must not override it.
    fake.world.hold = true;
    const composerInput = within(screen.getByTestId('composer')).getByRole('textbox');
    await user.type(composerInput, 'Follow-up question{Enter}');

    const c6Tab = within(tablist).getByRole('tab', { name: /Transformer paper review/ });
    await waitFor(() => expect(within(c6Tab).getByLabelText('Working')).toBeInTheDocument(), { timeout: 4500 });

    const staleC6Seq = pushListSummary('c6', { state: 'idle', unread: false, waiting_for_user: false });
    await waitFor(() => expect(services.chats.getState().listCursor).toBeGreaterThanOrEqual(staleC6Seq), { timeout: 6000 });
    expect(within(c6Tab).getByLabelText('Working')).toBeInTheDocument();

    // No stop or delete calls occurred across any of these operations.
    expect(fake.calls.some((c) => c.path.includes('/stop') || c.method === 'DELETE')).toBe(false);
  }, 15000);
});
