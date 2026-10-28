import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Segmented, Switch, SQUISH_MS } from './Controls';

/* SquishSwitch (stage 6, B10): the knob stretches while it travels (14 → 20 → 14 px); calm/off none. */

interface FakeAnimation { el: HTMLElement; frames: Keyframe[]; opts: KeyframeAnimationOptions }
function stubAnimate() {
  const played: FakeAnimation[] = [];
  (HTMLElement.prototype as unknown as { animate?: unknown }).animate = function animate(this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    played.push({ el: this, frames, opts });
    return { cancel: vi.fn(), finish: vi.fn() };
  };
  return played;
}

afterEach(() => {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  delete document.documentElement.dataset.motion;
});

function Harness({ start = false }: { start?: boolean }) {
  const [on, setOn] = useState(start);
  return <Switch label="Sounds" checked={on} onChange={setOn} />;
}
const knobAnims = (played: FakeAnimation[]) => played.filter((a) => a.el.classList.contains('kb-switch__knob'));

describe('SquishSwitch (B10)', () => {
  it('nothing plays on the first render', () => {
    const played = stubAnimate();
    render(<Harness start />);
    expect(knobAnims(played)).toHaveLength(0);
  });

  it('full: turning on, the knob stretches to 20 px at 45 % and lands round at the right', () => {
    const played = stubAnimate();
    render(<Harness />);
    fireEvent.click(screen.getByRole('switch', { name: 'Sounds' }));
    const [a] = knobAnims(played);
    expect(knobAnims(played)).toHaveLength(1);
    expect(a!.frames).toEqual([
      { transform: 'translateX(0px)', width: '14px' },
      { transform: 'translateX(0px)', width: '20px', offset: 0.45 },
      { transform: 'translateX(12px)', width: '14px' },
    ]);
    expect(a!.opts).toMatchObject({ duration: SQUISH_MS, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)' });
    expect(SQUISH_MS).toBe(300);
  });

  it('full: turning off, it stretches from the left edge and travels back', () => {
    const played = stubAnimate();
    render(<Harness start />);
    fireEvent.click(screen.getByRole('switch', { name: 'Sounds' }));
    expect(knobAnims(played)[0]!.frames).toEqual([
      { transform: 'translateX(12px)', width: '14px' },
      { transform: 'translateX(0px)', width: '20px', offset: 0.45 },
      { transform: 'translateX(0px)', width: '14px' },
    ]);
  });

  it.each(['calm', 'off'] as const)('%s: no squish (the plain slide / an instant change stays CSS)', (level) => {
    document.documentElement.dataset.motion = level;
    const played = stubAnimate();
    render(<Harness />);
    fireEvent.click(screen.getByRole('switch', { name: 'Sounds' }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(knobAnims(played)).toHaveLength(0);
  });

  it('the segmented control is unchanged: no knob animation', () => {
    const played = stubAnimate();
    function Seg() {
      const [v, setV] = useState<'a' | 'b'>('a');
      return <Segmented label="View" value={v} onChange={setV} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />;
    }
    render(<Seg />);
    fireEvent.click(screen.getByRole('radio', { name: 'B' }));
    expect(knobAnims(played)).toHaveLength(0);
  });
});
