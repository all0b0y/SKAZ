import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatMessage } from '../../test/fakeKb';
import { chatWorld } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';

const activeKey = 'kb-chat-find-active';
const highlights = new Map<string, Set<Range>>();
const shortcut = { key: 'f', ctrlKey: true };
const panel = () => screen.getByRole('search', { name: 'Find in this chat' });
const status = () => within(panel()).getByRole('status');
const activeRange = () => [...highlights.get(activeKey)!][0]!;

function findFrom(target: HTMLElement) {
  target.focus();
  expect(fireEvent.keyDown(target, shortcut)).toBe(false);
  const input = within(panel()).getByRole('textbox', { name: 'Text to find in this chat' });
  expect(input).toHaveFocus();
  return input;
}

function conversationBounds(scroll: HTMLElement) {
  Object.defineProperties(scroll, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 1200 },
    scrollTo: { value: vi.fn(({ top = scroll.scrollTop }: ScrollToOptions) => {
      scroll.scrollTop = Math.min(top, scroll.scrollHeight - scroll.clientHeight);
    }) },
  });
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
  scroll.scrollTop = 1000;
}

beforeEach(() => {
  highlights.clear();
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal('Highlight', Set);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('find in the open ChatView', () => {
  it('reveals each range within one long reply and restores the starting position and selection on Escape', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const chat = world.chats.find(({ id }) => id === 'c1')!;
    const answer = `CACHE starts here. ${'Intermediate lines of the answer. '.repeat(70)}And then cache ends here.`;
    chat.messages = [
      chatMessage('question', 1, 'user', chat.created_at, [{ type: 'text', text: 'Что такое кэш?' }]),
      chatMessage('answer', 2, 'assistant', chat.created_at, [{ type: 'text', text: answer }]),
    ];
    renderKb({ world, prefs: { motion: 'off' } });
    await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
    const question = await screen.findByText('Что такое кэш?');
    const scroll = screen.getByRole('log', { name: 'Conversation' });
    conversationBounds(scroll);

    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getClientRects = () => {
        const contentTop = range.startOffset === 0 ? 300 : 820;
        const rect = new DOMRect(20, contentTop - scroll.scrollTop, 50, 20);
        return Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
      };
      return range;
    });

    const selected = question.firstChild!;
    const selection = document.getSelection()!;
    scroll.focus();
    selection.setBaseAndExtent(selected, 8, selected, 4);
    const input = findFrom(scroll);
    expect(scroll.scrollTop).toBe(1000);
    expect(panel().parentElement).toBe(scroll.parentElement);
    fireEvent.change(input, { target: { value: 'cache' } });
    expect(status()).toHaveTextContent('Match 1 of 2');
    const first = activeRange();
    expect(first.toString()).toBe('CACHE');
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 210, behavior: 'instant' });
    expect(scroll.scrollTop).toBe(210);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(status()).toHaveTextContent('Match 2 of 2');
    expect(activeRange().startContainer).toBe(first.startContainer);
    expect(activeRange().startOffset).toBe(answer.lastIndexOf('cache'));
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 730, behavior: 'instant' });
    expect(scroll.scrollTop).toBe(730);

    selection.removeAllRanges();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('search', { name: 'Find in this chat' })).toBeNull();
    expect(scroll).toHaveFocus();
    expect(selection.anchorNode).toBe(selected);
    expect(selection.toString()).toBe('тако');
    expect(scroll.scrollTop).toBe(1000);
    expect(highlights.size).toBe(0);
  });

  it('gives find the viewport until close, then lets Return to latest jump to the bottom', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const chat = world.chats.find(({ id }) => id === 'c1')!;
    chat.messages = [chatMessage('answer', 1, 'assistant', chat.created_at, [
      { type: 'text', text: `CACHE starts here. ${'More conversation text. '.repeat(120)}` },
    ])];
    renderKb({ world, prefs: { motion: 'off' } });
    await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
    const scroll = screen.getByRole('log', { name: 'Conversation' });
    await waitFor(() => expect(scroll).toHaveTextContent('CACHE starts here.'));
    conversationBounds(scroll);

    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getClientRects = () => {
        const rect = new DOMRect(20, 300 - scroll.scrollTop, 50, 20);
        return Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
      };
      return range;
    });

    const latest = () => screen.queryByRole('button', { name: 'Return to the latest message' });
    scroll.scrollTop = 560;
    fireEvent.scroll(scroll);
    expect(latest()).toBeVisible();

    fireEvent.change(findFrom(scroll), { target: { value: 'cache' } });
    expect(activeRange().toString()).toBe('CACHE');
    expect(scroll.scrollTop).toBe(210);
    fireEvent.scroll(scroll);
    const competingControl = latest();
    if (competingControl) await user.click(competingControl);
    expect(scroll.scrollTop).toBe(210);
    expect(latest()).toBeNull();

    await user.click(within(panel()).getByRole('button', { name: 'Close chat search' }));
    expect(scroll.scrollTop).toBe(560);
    fireEvent.scroll(scroll);
    const returnButton = await screen.findByRole('button', { name: 'Return to the latest message' });
    await user.click(returnButton);
    expect(scroll.scrollTop).toBe(1000);
    expect(latest()).toBeNull();
  });

  it('closes find on Escape from a focused control outside the chat', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld(), prefs: { motion: 'off' } });
    await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
    const scroll = screen.getByRole('log', { name: 'Conversation' });
    conversationBounds(scroll);
    const sidebarChat = screen.getByRole('button', { name: /Seminar questions/ });

    findFrom(scroll);
    act(() => sidebarChat.focus());
    expect(sidebarChat).toHaveFocus();
    expect(fireEvent.keyDown(sidebarChat, shortcut)).toBe(true);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('search', { name: 'Find in this chat' })).toBeNull();
    expect(scroll).toHaveFocus();
    expect(scroll.scrollTop).toBe(1000);
  });

  it('lets the global search modal consume Escape with focus inside or lost to the body', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld(), prefs: { motion: 'off' } });
    await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
    const scroll = screen.getByRole('log', { name: 'Conversation' });
    conversationBounds(scroll);
    const input = findFrom(scroll);
    const search = screen.getByRole('button', { name: 'Search' });
    const globalInput = () => screen.findByRole('combobox', { name: 'Search the wiki, materials and chats' });
    const globalDialog = () => screen.queryByRole('dialog', { name: 'Search' });

    await user.click(search);
    expect(await globalInput()).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(globalDialog()).toBeNull());
    expect(input).toBeInTheDocument();

    await user.click(search);
    (await globalInput()).blur();
    expect(document.body).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(globalDialog()).toBeNull());
    expect(input).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(input).not.toBeInTheDocument();
    expect(scroll).toHaveFocus();
  });

  it('updates through the chat event stream and clears on switch without taking shortcuts from global search', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const chat = world.chats.find(({ id }) => id === 'c1')!;
    chat.state = 'answering';
    chat.messages = [
      chatMessage('question', 1, 'user', chat.created_at, [{ type: 'text', text: 'Где кэш?' }]),
      chatMessage('answer', 2, 'assistant', chat.created_at, [
        { type: 'tool', name: 'skaz_read_page', label: 'Tool-only кэш' },
        { type: 'text', text: 'В ответе: **Кэш**.' },
      ], { state: 'streaming' }),
    ];
    const { fake, services } = renderKb({ world, prefs: { motion: 'off' } });
    await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
    await screen.findByText('Кэш', { exact: true });
    const scroll = screen.getByRole('log', { name: 'Conversation' });
    conversationBounds(scroll);

    const input = findFrom(screen.getByRole('textbox', { name: 'Message' }));
    fireEvent.change(input, { target: { value: 'КЭШ' } });
    expect(status()).toHaveTextContent('Match 1 of 2');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(status()).toHaveTextContent('Match 2 of 2');
    scroll.scrollTop = 380;

    const streamingChat = fake.world.chats.find(({ id }) => id === chat.id)!;
    fake.world.chatEvents[chat.id] = [{ seq: ++streamingChat.cursor, type: 'delta', message_id: 'answer', text: ' Ещё кэш.' }];
    await waitFor(() => expect(status()).toHaveTextContent('Match 2 of 3'), { timeout: 4200 });
    expect(activeRange().toString()).toBe('Кэш');
    expect(scroll.scrollTop).toBe(380);

    await user.click(screen.getByRole('button', { name: /Seminar questions/ }));
    expect(screen.queryByRole('search', { name: 'Find in this chat' })).toBeNull();
    expect(highlights.size).toBe(0);
    fireEvent.change(findFrom(scroll), { target: { value: 'кэш' } });
    expect(status()).toHaveTextContent('No matches');
    act(() => services.ui.getState().openDocument({ type: 'material', id: 'm3' }));
    act(() => services.ui.getState().toggleDocExpanded());
    expect(screen.queryByRole('search', { name: 'Find in this chat' })).toBeNull();
    expect(fireEvent.keyDown(scroll, shortcut)).toBe(true);
    act(() => services.ui.getState().toggleDocExpanded());

    await user.click(screen.getByRole('button', { name: 'Search' }));
    const global = await screen.findByRole('combobox', { name: 'Search the wiki, materials and chats' });
    expect(global).toHaveFocus();
    expect(fireEvent.keyDown(global, shortcut)).toBe(true);
    expect(screen.queryByRole('search', { name: 'Find in this chat' })).toBeNull();
  });
});
