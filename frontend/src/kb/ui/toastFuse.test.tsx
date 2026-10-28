import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Toast, TOAST_SHOW_MS, type ToastData } from './Toast';

/* Toast fuse (stage 6, B4): a 2 px line shows the time left to Undo; hover/focus hold it (one timer). */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

const undo: ToastData = { id: 1, text: 'Deleted «Sample note»', action: { label: 'Undo', run: () => undefined } };
const plain: ToastData = { id: 2, text: 'Already pinned' };
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const toastEl = () => screen.getByTestId('toast');
const fuse = () => toastEl().querySelector<HTMLElement>('.kb-toast__fuse');
const countdown = () => toastEl().querySelector<HTMLElement>('.kb-toast__countdown');

describe('Toast fuse (B4)', () => {
  it('a toast with an action has the fuse line, decorative and as long as the toast lives; a plain note has none', () => {
    const { rerender } = render(<Toast toast={undo} onClose={() => undefined} />);
    expect(fuse()).not.toBeNull();
    expect(fuse()).toHaveAttribute('aria-hidden', 'true');
    expect(fuse()!.style.getPropertyValue('--kb-toast-life')).toBe(`${TOAST_SHOW_MS}ms`);
    expect(countdown()).toBeNull();
    rerender(<Toast toast={plain} onClose={() => undefined} />);
    expect(fuse()).toBeNull();
  });

  it('hover holds the fuse and the timer; leaving resumes the REMAINING time, not a fresh one', () => {
    const onClose = vi.fn();
    render(<Toast toast={undo} onClose={onClose} />);
    wait(4000);
    fireEvent.mouseEnter(toastEl());
    expect(toastEl()).toHaveClass('is-held');
    wait(20_000);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toastEl());
    expect(toastEl()).not.toHaveClass('is-held');
    wait(TOAST_SHOW_MS - 4000 - 1);
    expect(onClose).not.toHaveBeenCalled();
    wait(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focus holds it too; moving focus between its buttons does not release it', () => {
    const onClose = vi.fn();
    render(<Toast toast={undo} onClose={onClose} />);
    const action = screen.getByRole('button', { name: 'Undo' });
    const close = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.focus(action);
    expect(toastEl()).toHaveClass('is-held');
    fireEvent.blur(action, { relatedTarget: close });
    fireEvent.focus(close);
    expect(toastEl()).toHaveClass('is-held');
    wait(TOAST_SHOW_MS * 2);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.blur(close, { relatedTarget: document.body });
    expect(toastEl()).not.toHaveClass('is-held');
    wait(TOAST_SHOW_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pointer and focus are two holds: leaving with the pointer while a button is focused keeps it held', () => {
    const onClose = vi.fn();
    render(<Toast toast={undo} onClose={onClose} />);
    fireEvent.mouseEnter(toastEl());
    fireEvent.focus(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.mouseLeave(toastEl());
    expect(toastEl()).toHaveClass('is-held');
    wait(TOAST_SHOW_MS * 2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a new toast starts a fresh life', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Toast toast={undo} onClose={onClose} />);
    wait(5000);
    rerender(<Toast toast={{ ...undo, id: 3 }} onClose={onClose} />);
    wait(TOAST_SHOW_MS - 1);
    expect(onClose).not.toHaveBeenCalled();
    wait(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calm keeps the fuse (it is a status)', () => {
    document.documentElement.dataset.motion = 'calm';
    render(<Toast toast={undo} onClose={() => undefined} />);
    expect(fuse()).not.toBeNull();
    expect(countdown()).toBeNull();
  });

  it('off: no line — a «· N s» countdown in text that hover still holds', () => {
    document.documentElement.dataset.motion = 'off';
    const onClose = vi.fn();
    render(<Toast toast={undo} onClose={onClose} />);
    expect(fuse()).toBeNull();
    expect(countdown()).toHaveTextContent(`· ${TOAST_SHOW_MS / 1000} s`);
    expect(countdown()).toHaveAttribute('aria-hidden', 'true');
    wait(1000);
    expect(countdown()).toHaveTextContent(`· ${TOAST_SHOW_MS / 1000 - 1} s`);
    fireEvent.mouseEnter(toastEl());
    wait(5000);
    expect(countdown()).toHaveTextContent(`· ${TOAST_SHOW_MS / 1000 - 1} s`);
    fireEvent.mouseLeave(toastEl());
    wait(TOAST_SHOW_MS - 1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
