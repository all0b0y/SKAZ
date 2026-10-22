import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SpeechBars } from '../fx/indicators/SpeechBars';
import { speechBarCount, speechBarHeight, speechLevels } from '../fx/indicators/speech';

describe('Speech bars: pure mapping of the real levels', () => {
  it('fits 7 bars into 36 css px at a 5-px step', () => {
    expect(speechBarCount(36)).toBe(7);
    expect(speechBarCount(4)).toBe(0);
  });

  it('interpolates the levels across the bar count and keeps their ends', () => {
    const v = speechLevels([0, 1, 0], 5);
    expect(v).toEqual([0, 0.5, 1, 0.5, 0]);
    const w = speechLevels([0.2, 0.8, 0.5], 7);
    expect(w).toHaveLength(7);
    expect(w[0]).toBeCloseTo(0.2);
    expect(w[3]).toBeCloseTo(0.8);
    expect(w[6]).toBeCloseTo(0.5);
    expect(w.every((x) => x >= 0.2 - 1e-9 && x <= 0.8 + 1e-9)).toBe(true);
  });

  it('silence stays silence and nothing is invented', () => {
    expect(speechLevels([0, 0, 0], 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(speechLevels([], 3)).toEqual([0, 0, 0]);
    expect(speechLevels([0.4], 3)).toEqual([0.4, 0.4, 0.4]);
    expect(speechLevels([Number.NaN, 2, -1], 3)).toEqual([0, 1, 0]);
    expect(speechLevels([0.3, 0.9], 0)).toEqual([]);
    // Deterministic: the same levels always give the same bars.
    expect(speechLevels([0.1, 0.7, 0.4], 7)).toEqual(speechLevels([0.1, 0.7, 0.4], 7));
  });

  it('bar height: 2 px at silence, h - 1 at full scale, monotonic', () => {
    expect(speechBarHeight(0, 14)).toBe(2);
    expect(speechBarHeight(1, 14)).toBe(13);
    expect(speechBarHeight(0.5, 14)).toBeGreaterThan(speechBarHeight(0.2, 14));
    expect(speechBarHeight(5, 14)).toBe(13);
  });
});

describe('SpeechBars component', () => {
  it('renders an aria-hidden canvas inside an aria-hidden wrapper and mirrors the store levels', () => {
    const { container, rerender } = render(<SpeechBars levels={[0, 0, 0]} />);
    const wrap = container.querySelector('.kb-lvl')!;
    expect(wrap).toHaveAttribute('aria-hidden', 'true');
    expect(wrap.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
    expect(wrap).toHaveAttribute('data-levels', '0,0,0');
    rerender(<SpeechBars levels={[0.6, 0.8, 0.7]} />);
    expect(wrap).toHaveAttribute('data-levels', '0.6,0.8,0.7');
  });
});
