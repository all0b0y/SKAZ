import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Toast, TOAST_SHOW_MS, type ToastData } from './Toast';
import { MotionProvider } from './motion';

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

  describe('one clock (FIX2 S-L1 + C-L1)', () => {
    const setLevel = (level: 'full' | 'calm' | 'off') => act(async () => {
      document.documentElement.dataset.motion = level;
      await Promise.resolve();
    });

    it('a fresh toast’s fuse starts full (no delay)', () => {
      render(<Toast toast={undo} onClose={() => undefined} />);
      expect(fuse()!.style.animationDelay).toBe('0ms');
    });

    it('turning motion back on mid-toast mounts the fuse at the time already gone, not a fresh 6 s', async () => {
      document.documentElement.dataset.motion = 'off';
      const onClose = vi.fn();
      render(<Toast toast={undo} onClose={onClose} />);
      wait(4000);
      await setLevel('full');
      expect(countdown()).toBeNull();
      expect(fuse()!.style.animationDelay).toBe('-4000ms');
      wait(1000); // a re-render later does not re-time the running line
      expect(fuse()!.style.animationDelay).toBe('-4000ms');
      wait(TOAST_SHOW_MS - 5000);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a held toast remounts its fuse at the held point and stays paused', async () => {
      document.documentElement.dataset.motion = 'off';
      render(<Toast toast={undo} onClose={() => undefined} />);
      wait(2000);
      fireEvent.mouseEnter(toastEl());
      wait(3000);
      await setLevel('calm');
      expect(toastEl()).toHaveClass('is-held');
      expect(fuse()!.style.animationDelay).toBe('-2000ms');
    });

    it('a toast on its way out ignores the pointer and focus: it neither holds the next toast nor re-arms a timer', () => {
      const onClose = vi.fn();
      // In the app (MotionProvider) the old toast stays in the DOM while it fades out.
      const { rerender } = render(<MotionProvider><Toast toast={undo} onClose={onClose} /></MotionProvider>);
      wait(1000);
      rerender(<MotionProvider><Toast toast={{ ...undo, id: 7, text: 'Moved «Sample note»' }} onClose={onClose} /></MotionProvider>);
      const all = screen.getAllByTestId('toast');
      const leaving = all.find((el) => el.textContent?.includes('Deleted'));
      const next = all.find((el) => el.textContent?.includes('Moved'))!;
      expect(leaving, "the old toast is still fading out").toBeTruthy();
      if (leaving) {
        fireEvent.mouseEnter(leaving);
        fireEvent.focus(leaving.querySelector('button')!);
        expect(next).not.toHaveClass('is-held');
        fireEvent.mouseLeave(leaving);
        fireEvent.blur(leaving.querySelector('button')!, { relatedTarget: document.body });
      }
      wait(TOAST_SHOW_MS - 1);
      expect(onClose).not.toHaveBeenCalled();
      wait(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a closed toast fading out does not arm a stray close when the pointer passes over it', () => {
      const onClose = vi.fn();
      const { rerender } = render(<MotionProvider><Toast toast={undo} onClose={onClose} /></MotionProvider>);
      rerender(<MotionProvider><Toast toast={null} onClose={onClose} /></MotionProvider>);
      const leaving = screen.queryByTestId('toast');
      expect(leaving, "the old toast is still fading out").toBeTruthy();
      if (leaving) {
        fireEvent.mouseEnter(leaving);
        fireEvent.mouseLeave(leaving);
      }
      wait(TOAST_SHOW_MS * 2);
      expect(onClose).not.toHaveBeenCalled();
    });
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
