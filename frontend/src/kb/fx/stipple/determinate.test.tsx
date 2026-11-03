import { afterEach, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { FxColors } from '../colors';
import { drawStrip } from './draw';
import { StippleStrip } from './StippleStrip';

const colors: FxColors = { ink: [10, 20, 30], accent: [80, 90, 100] };
function paints(value?: number | null) {
  const output: string[] = [];
  const ctx = { fillStyle: '', beginPath: vi.fn(), arc: vi.fn(),
    fill: () => output.push(ctx.fillStyle) };
  drawStrip(ctx as unknown as CanvasRenderingContext2D, [[10, 3], [80, 3]], 100, 1.5, colors, value);
  return output;
}

afterEach(() => { delete document.documentElement.dataset.motion; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('a determinate strip lights only the fraction actually reported by its source, including zero', () => {
  const zero = paints(0);
  expect(zero[0]).toBe(zero[1]);
  const quarter = paints(0.25);
  expect(quarter[0]).not.toBe(quarter[1]);
  expect(quarter[1]).toBe(zero[1]);
  expect(paints(null)).toEqual(paints());
});

it('motion off redraws a new measured fraction without starting an animation loop', () => {
  document.documentElement.dataset.motion = 'off';
  const raf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  const { container, rerender } = render(<StippleStrip value={0} />);
  expect(container.querySelector('[data-stipple-strip]')).toHaveAttribute('data-progress', '0');
  rerender(<StippleStrip value={0.25} />);
  expect(container.querySelector('[data-stipple-strip]')).toHaveAttribute('data-progress', '0.25');
  expect(raf).not.toHaveBeenCalled();
});
