import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { KbChatSummary } from '../../api/kb/types.gen';
import { ChatMark, FINISH_MS, chatMarkKind } from './ChatMark';

const base: KbChatSummary = {
  id: 'c', title: 'A chat', pinned: false, engine: 'codex', model: null, effort: null,
  created_at: '2026-10-27T10:00:00Z', updated_at: '2026-10-27T10:00:00Z', last_preview: '',
  recording_material_id: null, folder_ids: [], state: 'idle', unread: false,
};
const answering: KbChatSummary = { ...base, state: 'answering' };
const ready: KbChatSummary = { ...base, state: 'idle', unread: true };
const mark = () => document.querySelector<HTMLElement>('[data-mark]');

afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

describe('chat mark state (decision 26)', () => {
  it('waiting keeps priority; the open chat shows nothing; then answering, finishing, new, none', () => {
    expect(chatMarkKind({ ...answering, waiting_for_user: true }, true, false)).toBe('waiting');
    expect(chatMarkKind({ ...ready, waiting_for_user: true }, false, true)).toBe('waiting');
    expect(chatMarkKind(answering, true, false)).toBe('none');
    expect(chatMarkKind(ready, true, true)).toBe('none');
    expect(chatMarkKind(answering, false, false)).toBe('answering');
    expect(chatMarkKind(ready, false, true)).toBe('finishing');
    expect(chatMarkKind(ready, false, false)).toBe('new');
    expect(chatMarkKind(base, false, false)).toBe('none');
  });

  it('a chat at work shows the nodes mark (a canvas), still saying «answering»', () => {
    render(<ChatMark chat={answering} current={false} />);
    const el = screen.getByRole('img', { name: 'answering' });
    expect(el).toHaveClass('kb-chatmark--answering');
    expect(el.querySelector('canvas.kb-chatmark__fx')).toHaveAttribute('aria-hidden', 'true');
  });

  it('answer ready: the nodes resolve into the «new» dot once, then the plain dot stays', () => {
    vi.useFakeTimers();
    const { rerender } = render(<ChatMark chat={answering} current={false} />);
    rerender(<ChatMark chat={ready} current={false} />);
    expect(mark()).toHaveAttribute('data-mark', 'finishing');
    expect(screen.getByRole('img', { name: 'new answer' }).querySelector('.kb-chatmark__late')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(FINISH_MS); });
    expect(mark()).toHaveAttribute('data-mark', 'new');
    // Another render does not play it again.
    rerender(<ChatMark chat={{ ...ready }} current={false} />);
    expect(mark()).toHaveAttribute('data-mark', 'new');
  });

  it('not on mount, not for the open chat, not when indicators are still', () => {
    const first = render(<ChatMark chat={ready} current={false} />);
    expect(mark()).toHaveAttribute('data-mark', 'new');
    first.unmount();

    const open = render(<ChatMark chat={answering} current />);
    expect(mark()).toBeNull();
    open.rerender(<ChatMark chat={ready} current />);
    expect(mark()).toBeNull();
    open.unmount();

    document.documentElement.dataset.motion = 'off';
    const still = render(<ChatMark chat={answering} current={false} />);
    still.rerender(<ChatMark chat={ready} current={false} />);
    expect(mark()).toHaveAttribute('data-mark', 'new');
  });

  it('opening the chat during the finish ends it at once', () => {
    const { rerender } = render(<ChatMark chat={answering} current={false} />);
    rerender(<ChatMark chat={ready} current={false} />);
    expect(mark()).toHaveAttribute('data-mark', 'finishing');
    rerender(<ChatMark chat={ready} current />);
    expect(mark()).toBeNull();
  });
});
