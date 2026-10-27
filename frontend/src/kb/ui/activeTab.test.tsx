import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { ActiveTab, REACH_DELAY_MS, springEasing, TUCK_MS, type TabVariant } from './ActiveTab';

interface FakeAnimation { el: HTMLElement; frames: Keyframe[]; opts: KeyframeAnimationOptions; onfinish: (() => void) | null; cancel: () => void; finish: () => void }

/** jsdom has no Web Animations: record every animate() and let the test finish or cancel it. */
function stubAnimate() {
  const played: FakeAnimation[] = [];
  const proto = HTMLElement.prototype as unknown as { animate?: unknown };
  proto.animate = function animate(this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const a: FakeAnimation = {
      el: this, frames, opts, onfinish: null,
      cancel: vi.fn(),
      finish() { a.onfinish?.(); },
    };
    played.push(a);
    return a;
  };
  return played;
}

afterEach(() => {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  delete document.documentElement.dataset.motion;
});

function List({ open, variant = 'bridge', ids = ['a', 'b', 'c'] }: { open: string | null; variant?: TabVariant; ids?: string[] }) {
  const host = useRef<HTMLUListElement | null>(null);
  return (
    <ul ref={host} className="kb-tabhost" data-testid="host">
      <ActiveTab host={host} activeKey={open} variant={variant} />
      {ids.map((id) => <li key={id}><button type="button" data-tab-key={id}>{id}</button></li>)}
    </ul>
  );
}

const tab = () => document.querySelector<HTMLElement>('[data-testid="active-tab"]')!;
const ghosts = () => document.querySelectorAll('.kb-tab--ghost');

describe('ActiveTab (decisions 24–25)', () => {
  it('one element per list marks the open row; none when no row is open; it never takes the pointer', () => {
    const { rerender } = render(<List open="b" />);
    expect(document.querySelectorAll('[data-testid="active-tab"]')).toHaveLength(1);
    expect(tab()).not.toHaveAttribute('hidden');
    expect(tab()).toHaveAttribute('data-tab-for', 'b');
    expect(tab()).toHaveClass('kb-tab', 'kb-tab--bridge');
    expect(tab().parentElement).toHaveAttribute('aria-hidden', 'true');
    rerender(<List open={null} />);
    expect(tab()).toHaveAttribute('hidden');
    expect(tab()).not.toHaveAttribute('data-tab-for');
    rerender(<List open="gone" />);
    expect(tab()).toHaveAttribute('hidden');
  });

  it('Tuck & reach: the old copy tucks right-to-left in 170 ms, the tab reaches out on a spring after 110 ms', () => {
    const played = stubAnimate();
    const { rerender } = render(<List open="a" />);
    expect(played).toHaveLength(0); // the first placement does not animate
    rerender(<List open="c" />);
    expect(ghosts()).toHaveLength(1);
    const [out, inn] = played;
    expect(out!.el).toBe(ghosts()[0]);
    expect(out!.frames).toEqual([{ clipPath: 'inset(-12px 0px -12px 0px)' }, { clipPath: 'inset(-12px 0px -12px 100%)' }]);
    expect(out!.opts).toMatchObject({ duration: TUCK_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)' });
    expect(inn!.el).toBe(tab());
    expect(inn!.frames).toEqual([{ clipPath: 'inset(-12px 0px -12px 100%)' }, { clipPath: 'inset(-12px 0px -12px 0px)' }]);
    expect(inn!.opts).toMatchObject({ delay: REACH_DELAY_MS, duration: springEasing(0.3, 0.12).duration });
    expect(String(inn!.opts.easing)).toMatch(/^linear\(/);
    // The tucked copy goes away when it ends.
    act(() => out!.finish());
    expect(ghosts()).toHaveLength(0);
  });

  it('rapid switches leave no stray copies: each switch stops the last one', () => {
    const played = stubAnimate();
    const { rerender } = render(<List open="a" />);
    rerender(<List open="b" />);
    rerender(<List open="c" />);
    rerender(<List open="a" />);
    expect(ghosts()).toHaveLength(1);
    // Everything but the last pair was cancelled.
    expect(played.slice(0, -2).every((a) => (a.cancel as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
    act(() => played.forEach((a) => a.finish()));
    expect(ghosts()).toHaveLength(0);
    expect(tab()).toHaveAttribute('data-tab-for', 'a');
  });

  it('calm: the bridge appears in place; off: everything is instant', () => {
    const played = stubAnimate();
    document.documentElement.dataset.motion = 'calm';
    const { rerender } = render(<List open="a" />);
    rerender(<List open="b" />);
    expect(played).toHaveLength(0);
    expect(ghosts()).toHaveLength(0);
    document.documentElement.dataset.motion = 'off';
    rerender(<List open="c" />);
    expect(played).toHaveLength(0);
    expect(tab()).toHaveAttribute('data-tab-for', 'c');
  });

  it('soft tile: a plain crossfade (no clip, no spring), kept at calm, instant at off', () => {
    const played = stubAnimate();
    document.documentElement.dataset.motion = 'calm';
    const { rerender } = render(<List open="a" variant="soft" />);
    expect(tab()).toHaveClass('kb-tab--soft');
    rerender(<List open="b" variant="soft" />);
    expect(played.map((a) => a.frames)).toEqual([[{ opacity: 1 }, { opacity: 0 }], [{ opacity: 0 }, { opacity: 1 }]]);
    document.documentElement.dataset.motion = 'off';
    rerender(<List open="c" variant="soft" />);
    expect(played).toHaveLength(2);
    expect(ghosts()).toHaveLength(0); // the off switch also dropped the last copy
  });

  it('moving the tab never touches the rows', () => {
    stubAnimate();
    const { rerender } = render(<List open="a" />);
    const rows = [...document.querySelectorAll('[data-tab-key]')];
    rerender(<List open="c" />);
    rerender(<List open={null} />);
    rerender(<List open="b" />);
    expect([...document.querySelectorAll('[data-tab-key]')]).toEqual(rows);
    rows.forEach((r) => expect(r.isConnected).toBe(true));
  });

  it('the spring easing settles at 1 and keeps the motion visualDuration × 1.6 when it bounces', () => {
    const s = springEasing(0.3, 0.12);
    expect(s.duration).toBe(480);
    expect(s.easing.endsWith(', 1)')).toBe(true);
    expect(springEasing(0.32, 0).duration).toBe(400);
  });
});
