import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { chatMessage } from '../test/fakeKb';
import { LEAVE_MS } from './ChatView';

/*
 * FX Batch A in the chat: the dither field behind an empty chat, its plate, the first message's
 * transition and the «Connecting nodes» waiting mark (FX-EFFECTS-SPEC §1, 5–8). jsdom has no canvas:
 * these tests pin what is rendered and when; the pixels are covered by fx/fx.test.ts.
 */

const side = () => screen.getByRole('region', { name: 'Chats' });
const centre = () => screen.getByRole('region', { name: 'Chat' });
const field = () => centre().querySelector('canvas.kb-fx-field');
const stage = () => centre().querySelector('.kb-chat__stage')!;
const plate = () => centre().querySelector('.kb-chat__plate');

/**
 * Holds the leave timer (the setTimeout of `ms`) so the test, not the wall clock, ends the transition:
 * no time bounds that a loaded run could break (quality Q8).
 */
function holdLeaveTimer(ms: number) {
  const real = window.setTimeout.bind(window);
  const held: Array<() => void> = [];
  vi.spyOn(window, 'setTimeout').mockImplementation(((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === ms && typeof fn === 'function') {
      held.push(() => (fn as (...a: unknown[]) => void)(...args));
      return 0;
    }
    return real(fn, delay, ...args);
  }) as typeof window.setTimeout);
  return {
    get count() { return held.length; },
    end: () => act(() => { held.splice(0).forEach((f) => f()); }),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Empty chat: the dither field', () => {
  it('no chat selected: the field is there, decorative; the copy is on the plate above the message field', async () => {
    renderKb({ world: chatWorld() });
    await within(side()).findByRole('region', { name: 'Pinned' });
    expect(field()).toBeInTheDocument();
    expect(field()).toHaveAttribute('aria-hidden', 'true');
    expect(stage()).toHaveAttribute('data-fx', 'field');
    expect(stage()).toHaveAttribute('data-interactive', 'true'); // crosshair, clicks connect
    expect(plate()).toHaveTextContent('Ask about your materials');
    expect(plate()).toHaveTextContent('Answers cite the exact moments of your recordings and the pages of your documents. Type @ to point at a page, a material or a chat.');
    // No text on the canvas area: the conversation log holds nothing, the plate sits outside it.
    const log = within(centre()).getByRole('log', { name: 'Conversation' });
    expect(log).toBeEmptyDOMElement();
    expect(log.contains(plate())).toBe(false);
    expect(stage().contains(plate())).toBe(false);
    // The plate comes right before the message field.
    expect(plate()!.nextElementSibling).toContainElement(screen.getByTestId('message-input'));
    // Clicking the empty area is harmless where there is no canvas (jsdom).
    await userEvent.setup().pointer({ keys: '[MouseLeft]', target: log });
    expect(field()).toBeInTheDocument();
  });

  it('an open chat with no messages (a recording opened it) shows the field and its own copy', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    Object.assign(world.chats.find((c) => c.id === 'c2')!, { messages: [], state: 'idle' });
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /What did I miss in lecture 8/ }));
    await waitFor(() => expect(plate()).toHaveTextContent('Ask about the lecture'));
    expect(plate()).toHaveTextContent('Questions here are answered from what has been recognised so far.');
    expect(field()).toHaveAttribute('aria-hidden', 'true');
  });

  it('an empty chat that is not a recording: «No messages yet»', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    Object.assign(world.chats.find((c) => c.id === 'c3')!, { messages: [] });
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Compare regularisation/ }));
    await waitFor(() => expect(plate()).toHaveTextContent('No messages yet'));
    expect(plate()).toHaveTextContent('Ask about your materials. Type @ to point at a page, a material or a chat.');
    expect(field()).toBeInTheDocument();
  });

  it('a chat with messages: no field, no plate, no transition', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    await within(centre()).findByRole('article', { name: 'Answer' });
    expect(field()).toBeNull();
    expect(plate()).toBeNull();
    expect(stage()).not.toHaveAttribute('data-fx');
    expect(centre().querySelector('.kb-chat__messages--enter')).toBeNull();
  });

  it('the first message: the field burns out, the plate fades, only the question rises; then an ordinary chat', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true; // the answer keeps streaming: «Writing an answer…» stays to be seen
    renderKb({ world });
    await within(side()).findByRole('region', { name: 'Pinned' });
    const leave = holdLeaveTimer(LEAVE_MS);
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('What is entropy?{Enter}');
    await within(centre()).findByRole('article', { name: 'Your question' });
    expect(leave.count).toBe(1); // the burn-out lasts LEAVE_MS
    expect(stage()).toHaveAttribute('data-fx', 'leaving');
    expect(stage()).not.toHaveAttribute('data-interactive'); // no clicks while it leaves
    expect(field()).toBeInTheDocument();
    expect(plate()).toHaveAttribute('data-leaving', 'true');
    // The copy stays the new chat's (no «No messages yet» flash for the chat the send created).
    expect(plate()).toHaveTextContent('Ask about your materials');
    const messages = centre().querySelector('.kb-chat__messages')!;
    expect(messages).toHaveClass('kb-chat__messages--enter');
    expect(messages.firstElementChild).toHaveAttribute('aria-label', 'Your question');
    // F3: no text over the burning field — only the rising question; the answer waits for the end.
    expect(messages.children).toHaveLength(1);
    expect(within(centre()).queryByText('Writing an answer…')).toBeNull();
    // However long the test takes, it stays leaving until the leave timer ends it.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(field()).toBeInTheDocument();
    leave.end();
    expect(field()).toBeNull();
    expect(plate()).toBeNull();
    expect(stage()).not.toHaveAttribute('data-fx');
    expect(centre().querySelector('.kb-chat__messages')).not.toHaveClass('kb-chat__messages--enter');
    // The waiting mark: the decorative canvas beside the words, the words are the status.
    const status = within(centre()).getByText('Writing an answer…');
    expect(status).toHaveAttribute('role', 'status');
    expect(status.querySelector('canvas.kb-msg__think')).toHaveAttribute('aria-hidden', 'true');
  });

  it('F2: the send lands in one commit — the same plate node fades, the question rises with it, never «No messages yet»', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true;
    renderKb({ world });
    await within(side()).findByRole('region', { name: 'Pinned' });
    const before = plate();
    expect(before).not.toBeNull();
    // Every committed DOM state between the send and the question: a MutationObserver callback runs
    // after each commit, before a later (lower-priority) render could fix it up.
    const frames: Array<{ plate: string | null; leaving: string | null; messages: string | null; field: boolean }> = [];
    const mo = new MutationObserver(() => {
      const list = centre().querySelector('.kb-chat__messages');
      frames.push({
        plate: plate()?.textContent ?? null,
        leaving: plate()?.getAttribute('data-leaving') ?? null,
        messages: list ? list.className : null,
        field: !!field(),
      });
    });
    mo.observe(centre(), { subtree: true, childList: true, attributes: true, characterData: true });
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('What is entropy?{Enter}');
    await within(centre()).findByRole('article', { name: 'Your question' });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    mo.disconnect();
    expect(frames.filter((f) => f.plate?.includes('No messages yet'))).toEqual([]);
    // Every committed state with the question already has the plate leaving, the field burning and the rise.
    const withMessages = frames.filter((f) => f.messages !== null);
    expect(withMessages.length).toBeGreaterThan(0);
    for (const f of withMessages) {
      expect(f).toMatchObject({ leaving: 'true', field: true });
      expect(f.messages).toContain('kb-chat__messages--enter');
    }
    // The plate was never unmounted: the same node carries data-leaving, so its 250 ms fade runs.
    expect(plate()).toBe(before);
    expect(plate()).toHaveAttribute('data-leaving', 'true');
  });

  it('a system message into an empty chat (a model switch note) removes the field without the transition', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    Object.assign(world.chats.find((c) => c.id === 'c3')!, { messages: [] });
    const { services } = renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Compare regularisation/ }));
    await waitFor(() => expect(plate()).toHaveTextContent('No messages yet'));
    const leave = holdLeaveTimer(LEAVE_MS);
    const note = chatMessage('c3-s1', 1, 'system', '2026-10-22T10:00:00Z', [{ type: 'text', text: 'Model changed to Opus' }]);
    act(() => {
      services.chats.setState((s) => {
        const open = s.chats.c3!;
        return { chats: { ...s.chats, c3: { ...open, chat: { ...open.chat!, messages: [note] } } } };
      });
    });
    expect(within(centre()).getByRole('note')).toHaveTextContent('Model changed to Opus');
    expect(field()).toBeNull();
    expect(plate()).toBeNull();
    expect(stage()).not.toHaveAttribute('data-fx');
    expect(centre().querySelector('.kb-chat__messages')).not.toHaveClass('kb-chat__messages--enter');
    expect(leave.count).toBe(0);
  });

  it('opening an old chat from the empty view is not a «first message»: no transition', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    expect(await within(side()).findByRole('region', { name: 'Pinned' })).toBeInTheDocument();
    expect(field()).toBeInTheDocument();
    await user.click(within(side()).getByRole('button', { name: /Why is there a logarithm/ }));
    await within(centre()).findByRole('article', { name: 'Answer' });
    expect(field()).toBeNull();
    expect(stage()).not.toHaveAttribute('data-fx');
  });

  it('«Connecting nodes» waits in an old chat too (it is the waiting mark, not the background)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true;
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    await within(centre()).findByRole('article', { name: 'Answer' });
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('And the base of the logarithm?{Enter}');
    const wait = await within(centre()).findByText('Writing an answer…');
    expect(wait).toHaveAttribute('role', 'status');
    expect(wait.querySelector('canvas.kb-msg__think')).toHaveAttribute('aria-hidden', 'true');
    expect(field()).toBeNull();
  });
});
