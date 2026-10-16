import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CITATION_FOCUS_MS, useCitationFocus } from './useCitationFocus';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useCitationFocus — a citation jump is one-shot', () => {
  it('focuses the cited fragment, then lets go after the highlight', () => {
    const hook = renderHook(() => useCitationFocus());
    act(() => hook.result.current.cite('seg-1', 's1'));
    act(() => { vi.advanceTimersByTime(0); });
    expect(hook.result.current.focus).toEqual({ segmentId: 'seg-1', sessionId: 's1' });
    act(() => { vi.advanceTimersByTime(CITATION_FOCUS_MS - 1); });
    expect(hook.result.current.focus).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(hook.result.current.focus).toBeNull();
  });

  it('drops the focus at once when the reader leaves the transcript', () => {
    const hook = renderHook(() => useCitationFocus());
    act(() => hook.result.current.cite('seg-1', 's1'));
    act(() => { vi.advanceTimersByTime(0); });
    act(() => hook.result.current.clear());
    expect(hook.result.current.focus).toBeNull();
    // A pending expiry must not resurrect or disturb anything later.
    act(() => { vi.advanceTimersByTime(CITATION_FOCUS_MS * 2); });
    expect(hook.result.current.focus).toBeNull();
  });

  it('a repeat click on the same citation is a new jump', () => {
    const seen: Array<string | null> = [];
    const hook = renderHook(() => {
      const focus = useCitationFocus();
      seen.push(focus.focus?.segmentId ?? null);
      return focus;
    });
    act(() => hook.result.current.cite('seg-1', 's1'));
    act(() => { vi.advanceTimersByTime(0); });
    seen.length = 0;
    act(() => hook.result.current.cite('seg-1', 's1'));
    // Cleared first, so the transcript sees the prop change again.
    expect(seen).toContain(null);
    act(() => { vi.advanceTimersByTime(0); });
    expect(hook.result.current.focus?.segmentId).toBe('seg-1');
    // The expiry restarts from the second click.
    act(() => { vi.advanceTimersByTime(CITATION_FOCUS_MS - 1); });
    expect(hook.result.current.focus).not.toBeNull();
  });
});
