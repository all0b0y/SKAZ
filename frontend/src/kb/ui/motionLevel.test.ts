import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { effectiveMotion, useMotionLevel, useReducedMotion, useStillIndicators } from './motionLevel';

const system = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async (orig) => ({ ...(await orig<typeof import('motion/react')>()), useReducedMotion: () => system.reduced }));

describe('motion level', () => {
  it('the system setting caps the knob at calm; the knob can only take motion away', () => {
    expect(effectiveMotion('full', false)).toBe('full');
    expect(effectiveMotion('full', true)).toBe('calm');
    expect(effectiveMotion('calm', false)).toBe('calm');
    expect(effectiveMotion('off', false)).toBe('off');
    expect(effectiveMotion('off', true)).toBe('off');
  });

  it('follows html[data-motion]; indicators stop only when off or the system asks', async () => {
    delete document.documentElement.dataset.motion;
    const { result } = renderHook(() => ({ level: useMotionLevel(), reduced: useReducedMotion(), still: useStillIndicators() }));
    expect(result.current).toEqual({ level: 'full', reduced: false, still: false });
    await act(async () => { document.documentElement.dataset.motion = 'calm'; await Promise.resolve(); });
    expect(result.current).toEqual({ level: 'calm', reduced: true, still: false });
    await act(async () => { document.documentElement.dataset.motion = 'off'; await Promise.resolve(); });
    expect(result.current).toEqual({ level: 'off', reduced: true, still: true });
    delete document.documentElement.dataset.motion;
  });

  it('with the system reduce-motion on, indicators are a still frame even at full', () => {
    system.reduced = true;
    const { result } = renderHook(() => ({ level: useMotionLevel(), still: useStillIndicators() }));
    expect(result.current).toEqual({ level: 'calm', still: true });
    system.reduced = false;
  });
});
