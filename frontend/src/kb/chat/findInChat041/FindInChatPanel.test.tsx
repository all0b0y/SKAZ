import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineMarkdown } from '../Markdown';
import { FindInChatPanel } from './FindInChatPanel';
import { useFindInChat } from './useFindInChat';

const matchKey = 'kb-chat-find-match';
const activeKey = 'kb-chat-find-active';
const highlights = new Map<string, Set<Range>>();

function Conversation({ chatId = 'chat-a', reducedMotion = true, children }: {
  chatId?: string | null;
  reducedMotion?: boolean;
  children: ReactNode;
}) {
  const scopeRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const find = useFindInChat({ chatId, scopeRef, scrollRef, reducedMotion });
  return (
    <>
      <input aria-label="Outside editor" />
      <section ref={scopeRef} aria-label="Chat">
        <div className="kb-chat__stage">
          <div ref={scrollRef} role="log" aria-label="Conversation" tabIndex={0} className="kb-chat__scroll">
            {children}
          </div>
          <FindInChatPanel find={find} />
        </div>
        <textarea aria-label="Compose" defaultValue="Keep my draft" />
      </section>
    </>
  );
}

function Question({ children }: { children: ReactNode }) {
  return <article className="kb-msg--user" data-message-id="question"><div className="kb-msg__bubble">{children}</div></article>;
}

function Answer({ id = 'answer', children }: { id?: string; children: ReactNode }) {
  return (
    <article className="kb-msg--assistant" data-message-id={id}>
      <div>Thinking noise</div>
      <div className="kb-msg__body">{children}</div>
      <button type="button">Answer actions</button>
    </article>
  );
}

function mockScroller() {
  const scroll = screen.getByRole('log');
  Object.defineProperty(scroll, 'scrollTo', {
    configurable: true,
    value: vi.fn(({ top, left }: ScrollToOptions) => {
      if (top !== undefined) scroll.scrollTop = top;
      if (left !== undefined) scroll.scrollLeft = left;
    }),
  });
  return scroll;
}

function openFrom(target: HTMLElement, shortcut: KeyboardEventInit = { metaKey: true, key: 'f' }) {
  target.focus();
  expect(fireEvent.keyDown(target, shortcut)).toBe(false);
  const input = screen.getByRole('textbox', { name: 'Text to find in this chat' }) as HTMLInputElement;
  expect(input).toHaveFocus();
  return input;
}

const search = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });
const status = () => within(screen.getByRole('search')).getByRole('status');
const activeText = () => [...(highlights.get(activeKey) ?? [])].map(String).join('');

beforeEach(() => {
  highlights.clear();
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal('Highlight', Set);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('chat find panel', () => {
  it('scopes the shortcut, navigates with buttons and keys, and restores input focus and selection', () => {
    render(<Conversation><Question>KV <b>cache</b></Question><Answer>KV Cache in history</Answer></Conversation>);
    const scroll = mockScroller();
    const outside = screen.getByRole('textbox', { name: 'Outside editor' });
    outside.focus();
    expect(fireEvent.keyDown(outside, { key: 'f', ctrlKey: true })).toBe(true);
    expect(screen.queryByRole('search')).toBeNull();

    const draft = screen.getByRole('textbox', { name: 'Compose' }) as HTMLTextAreaElement;
    draft.focus();
    draft.setSelectionRange(2, 7, 'backward');
    scroll.scrollTop = 25;
    const input = openFrom(draft, { ctrlKey: true, key: 'а', code: 'KeyF' });
    expect(scroll.scrollTop).toBe(25);
    expect(status()).toHaveTextContent('0 / 0');
    search(input, 'unknown');
    expect(status()).toHaveTextContent('No matches');
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();

    search(input, 'kv cache');
    expect(status()).toHaveTextContent('Match 1 of 2');
    expect(activeText()).toBe('KV cache');
    expect([...highlights.get(matchKey)!].map(String)).toEqual(['KV Cache']);
    expect(fireEvent.keyDown(input, { key: 'Home' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'End' })).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(status()).toHaveTextContent('Match 2 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(status()).toHaveTextContent('Match 1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(status()).toHaveTextContent('Match 2 of 2');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(status()).toHaveTextContent('Match 1 of 2');

    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'F', metaKey: true });
    expect(input.selectionEnd).toBe(input.value.length);
    scroll.scrollTop = 90;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(draft).toHaveFocus();
    expect([draft.selectionStart, draft.selectionEnd, draft.selectionDirection]).toEqual([2, 7, 'backward']);
    expect(scroll.scrollTop).toBe(25);
    expect(highlights.size).toBe(0);
  });

  it('searches rendered Markdown, structured answers and visible diagram labels', async () => {
    const markdown = '### KV *cache*\n\n| Name | Details |\n| --- | --- |\n| Кэш | In RAM |\n\n'
      + '[Read more](https://example.invalid/raw-destination)\n\n```ts\nconst cached = 1;\n```\n\n'
      + '```mermaid\nflowchart LR\nA[Кэш diagram] --> B[RAM]\n```';
    render(<Conversation>
      <Question>Where is cache?</Question>
      <Answer>
        <InlineMarkdown pieces={[markdown]} slot={() => null} />
        <section className="kb-blk"><div className="kb-blk__title">Answer block title</div></section>
        <span hidden>Hidden from search</span>
        <span style={{ display: 'none' }}>CSS hidden</span>
        <details><summary>Details summary</summary><span>Closed content</span></details>
      </Answer>
    </Conversation>);
    const scroll = mockScroller();
    const input = openFrom(scroll);
    search(input, 'КЭШ');
    await waitFor(() => expect(status()).toHaveTextContent('Match 1 of 2'));
    expect(activeText()).toBe('Кэш');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(scroll.querySelector('text[data-kb-chat-find-label="active"]')).toHaveTextContent('Кэш diagram');
    search(input, 'KV cache');
    expect(activeText()).toBe('KV cache');
    for (const label of ['Read more', 'const cached', 'Answer block title', 'Details summary']) {
      search(input, label);
      expect(status()).toHaveTextContent('Match 1 of 1');
    }
    for (const hidden of ['raw-destination', 'flowchart LR', 'Кэш In RAM', 'Thinking noise', 'Answer actions',
      'Hidden from search', 'CSS hidden', 'Closed content']) {
      search(input, hidden);
      expect(status()).toHaveTextContent('No matches');
    }
    expect(scroll.querySelector('[data-kb-chat-find-label]')).toBeNull();
  });

  it('keeps the active result through streaming and clears on a chat switch', async () => {
    const { rerender } = render(<Conversation><Question>cache</Question><Answer>Old cache</Answer></Conversation>);
    const scroll = mockScroller();
    const input = openFrom(scroll);
    search(input, 'cache');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(status()).toHaveTextContent('Match 2 of 2');
    const oldActive = highlights.get(activeKey)!.values().next().value!.startContainer;

    rerender(<Conversation><Question>cache cache</Question><Answer>Old cache, then CACHE</Answer></Conversation>);
    await waitFor(() => expect(status()).toHaveTextContent('Match 3 of 4'));
    const active = highlights.get(activeKey)!.values().next().value!;
    expect(active.startContainer).toBe(oldActive);
    expect(active.startOffset).toBe(4);
    expect(scroll.scrollTo).toHaveBeenCalledTimes(0);

    rerender(<Conversation><Question>cache cache</Question><Answer>Replaced cache</Answer></Conversation>);
    await waitFor(() => expect(status()).toHaveTextContent('Match 3 of 3'));
    scroll.scrollTop = 70;
    rerender(<Conversation chatId="chat-b"><Answer id="other">Another chat</Answer></Conversation>);
    expect(screen.queryByRole('search')).toBeNull();
    expect(scroll.scrollTop).toBe(70);
    expect(highlights.size).toBe(0);
    const newInput = openFrom(scroll);
    expect(newInput).toHaveValue('');
    search(newInput, 'cache');
    expect(status()).toHaveTextContent('No matches');
    rerender(<Conversation chatId="chat-b"><Answer id="other">Another chat: cache</Answer></Conversation>);
    await waitFor(() => expect(status()).toHaveTextContent('Match 1 of 1'));
    expect(activeText()).toBe('cache');
    search(newInput, 'another');
    expect(activeText()).toBe('Another');
  });

  it('uses the active range to reveal an offscreen hit and retains DOM selection', () => {
    const { unmount } = render(<Conversation reducedMotion={false}>
      <Question><span>Selected text</span></Question>
      <Answer><p>Target from far up the history</p></Answer>
    </Conversation>);
    const scroll = mockScroller();
    Object.defineProperties(scroll, { clientHeight: { value: 200 }, scrollHeight: { value: 1300 } });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 300, 200));
    const target = screen.getByText('Target from far up the history');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 800, 140, 20));
    const selected = screen.getByText('Selected text').firstChild!;
    const selection = document.getSelection()!;
    scroll.focus();
    selection.setBaseAndExtent(selected, 8, selected, 0);
    const input = openFrom(scroll);
    search(input, 'Target');
    expect(activeText()).toBe('Target');
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 610, behavior: 'smooth' });
    const selectedNodeAfterFind = screen.getByText('Selected text').firstChild;
    expect(selectedNodeAfterFind).toBe(selected);
    act(() => selection.removeAllRanges());
    fireEvent.click(screen.getByRole('button', { name: 'Close chat search' }));
    expect(selection.toString()).toBe('Selected');
    expect(selection.anchorOffset).toBe(8);
    expect(scroll).toHaveFocus();
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: 'instant' });

    search(openFrom(scroll), 'Target');
    unmount();
    expect(highlights.size).toBe(0);
  });
});
