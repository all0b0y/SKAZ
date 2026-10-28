import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import type { CaptureCallbacks, CaptureEngine } from './capture';
import type { MotionLevel as MotionPref } from '../ui/motionLevel';
import { useRef, useState } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { CALM_FADE_MS, CONTENT_DELAY_MS, CONTENT_FADE_MS, SWELL, swellPlan, useVoicePill, type PillShape } from './voicePill';

/*
 * VoicePill (stage 6, B7): the Record pill swells into the recording capsule and back. jsdom has no
 * layout and no Web Animations: widths are given per shape and `animate` is recorded, so the tests pin
 * WHAT plays at each motion level; the look is checked in Chromium (motion6/build-shots/8-*).
 */

describe('swellPlan', () => {
  it('full: the width springs from the old pill to the new one and the new content fades in', () => {
    expect(swellPlan('full', 150, 172)).toEqual({ width: [150, 172], fade: 'content' });
    expect(swellPlan('full', 172, 150)).toEqual({ width: [172, 150], fade: 'content' });
  });
  it('full without a measured width (first paint, hidden title bar): only the content fade', () => {
    expect(swellPlan('full', 0, 172)).toEqual({ width: null, fade: 'content' });
    expect(swellPlan('full', 150, 150.4)).toEqual({ width: null, fade: 'content' });
  });
  it('calm: the capsule crossfades, no swell; off: nothing', () => {
    expect(swellPlan('calm', 150, 172)).toEqual({ width: null, fade: 'whole' });
    expect(swellPlan('off', 150, 172)).toEqual({ width: null, fade: null });
  });
  it('the swell is the approved spring (visualDuration 0.32, no bounce)', () => {
    expect(SWELL.duration).toBe(400);
    expect(SWELL.easing.startsWith('linear(0,')).toBe(true);
  });
});

interface Played { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions }

/** Width of each shape the slot can hold (css px) — what Chromium measures, roughly. */
const WIDTH: Record<string, number> = { 'kb-recgo': 150, 'kb-capwrap': 172, 'kb-pill': 196 };

let played: Played[] = [];
beforeEach(() => {
  played = [];
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      played.push({ el: this, frames, opts });
      return { cancel: vi.fn(), finished: new Promise(() => undefined) } as unknown as Animation;
    },
  });
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('kb-voicepill')) {
      const inner = this.firstElementChild;
      const w = Object.entries(WIDTH).find(([cls]) => inner?.classList.contains(cls))?.[1] ?? 0;
      return { width: w, height: 28, top: 0, left: 0, right: w, bottom: 28, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return real.call(this);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

function engine() {
  let cb: CaptureCallbacks | null = null;
  const e: CaptureEngine = {
    start: vi.fn(async (_s, c) => { cb = c; }),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    elapsedMs: () => 0,
    pending: () => ({ pending: 0, failed: 0 }),
  };
  return { e, level: (dbfs: number) => act(() => cb!.onLevel({ dbfs, peakDbfs: dbfs + 4, clipping: false })) };
}

async function start(motion: MotionPref) {
  const eng = engine();
  const user = userEvent.setup();
  const r = renderKb({ world: docWorld(), capture: () => eng.e, prefs: { motion } });
  const bar = screen.getByTestId('titlebar');
  const record = await within(bar).findByRole('button', { name: 'Record' });
  await waitFor(() => expect(record).not.toHaveAttribute('aria-disabled'));
  const slot = bar.querySelector('.kb-voicepill') as HTMLElement;
  return { ...r, eng, user, bar, record, slot };
}

const onSlot = (slot: Element) => played.filter((p) => p.el === slot);
const onContent = (slot: Element) => played.filter((p) => p.el.parentElement === slot);

describe('VoicePill in the title bar', () => {
  it('full: Record swells into the capsule (150 → 172 px, the spring) and the capsule content fades in after 60 ms', async () => {
    const { user, bar, record, slot } = await start('full');
    expect(slot).toBeInTheDocument();
    expect(onSlot(slot)).toEqual([]); // nothing on the first paint
    await user.click(record);
    await within(bar).findByRole('button', { name: /^Recording 00:00/ });
    const swell = onSlot(slot).find((p) => 'width' in (p.frames[0] ?? {}));
    expect(swell?.frames).toEqual([{ width: '150px' }, { width: '172px' }]);
    expect(swell?.opts).toMatchObject({ duration: SWELL.duration, easing: SWELL.easing });
    const fade = onContent(slot).find((p) => p.el.classList.contains('kb-capwrap'));
    expect(fade?.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(fade?.opts).toMatchObject({ duration: CONTENT_FADE_MS, delay: CONTENT_DELAY_MS, fill: 'backwards' });
  });

  it('full: Stop shrinks it back through «Finishing» to Record', async () => {
    const { user, bar, record, slot } = await start('full');
    await user.click(record);
    const capsule = await within(bar).findByRole('button', { name: /^Recording 00:00/ });
    played = [];
    await user.click(capsule);
    await user.click(within(await screen.findByRole('dialog', { name: 'Recording controls' })).getByRole('button', { name: 'Stop' }));
    await within(bar).findByRole('button', { name: 'Record' });
    const widths = onSlot(slot).filter((p) => 'width' in (p.frames[0] ?? {})).map((p) => p.frames.map((f) => f.width));
    // Back to Record's width (through «Finishing transcript…» when that phase gets painted).
    expect(widths.at(-1)?.[1]).toBe('150px');
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.every(([a, b]) => a !== b)).toBe(true);
  });

  it('the bars stay the REAL signal inside the swollen capsule (no CSS animation, levels from the meter)', async () => {
    const { user, bar, record, eng } = await start('full');
    await user.click(record);
    const capsule = await within(bar).findByRole('button', { name: /^Recording 00:00/ });
    const lvl = capsule.querySelector('.kb-lvl')!;
    expect(lvl).toHaveAttribute('data-levels', '0,0,0');
    eng.level(-8);
    expect((lvl.getAttribute('data-levels') ?? '').split(',').some((h) => h !== '0')).toBe(true);
    eng.level(-70);
    expect(lvl).toHaveAttribute('data-levels', '0,0,0');
    expect(played.some((p) => p.el === lvl || lvl.contains(p.el))).toBe(false);
  });

  it('calm: the capsule crossfades in place (160 ms), no width spring', async () => {
    const { user, bar, record, slot } = await start('calm');
    await user.click(record);
    await within(bar).findByRole('button', { name: /^Recording 00:00/ });
    expect(onSlot(slot).some((p) => 'width' in (p.frames[0] ?? {}))).toBe(false);
    const fade = onSlot(slot).find((p) => 'opacity' in (p.frames[0] ?? {}));
    expect(fade?.opts).toMatchObject({ duration: CALM_FADE_MS });
    expect(slot).not.toHaveClass('is-swelling');
  });

  it('off: the capsule just appears', async () => {
    const { user, bar, record, slot } = await start('off');
    await user.click(record);
    await within(bar).findByRole('button', { name: /^Recording 00:00/ });
    expect(onSlot(slot)).toEqual([]);
    expect(onContent(slot)).toEqual([]);
  });
});

/*
 * FIX2 C-M4: the resting width follows the slot itself (a ResizeObserver), not only the renders of the
 * control that owns it — the idle pill can widen by its own state (the saved folder name loads late).
 * jsdom has no ResizeObserver: a fake one records what is observed and lets the test deliver a resize.
 */
describe('VoicePill: the resting width is kept current', () => {
  let observers: { cb: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver }[] = [];
  let midSwell: number | null = null;
  beforeEach(() => {
    observers = [];
    midSwell = null;
    class FakeResizeObserver {
      private entry: (typeof observers)[number];
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: new Set(), self: this as unknown as ResizeObserver };
        observers.push(this.entry);
      }
      observe(el: Element) { this.entry.targets.add(el); }
      unobserve(el: Element) { this.entry.targets.delete(el); }
      disconnect() { this.entry.targets.clear(); }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const w = this.classList.contains('is-swelling') && midSwell !== null
        ? midSwell : Number(this.firstElementChild?.getAttribute('data-w') ?? 0);
      return { width: w, height: 28, top: 0, left: 0, right: w, bottom: 28, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** The browser reports a size change of every observed element. */
  const resize = () => act(() => {
    for (const o of observers) {
      const entries = [...o.targets].map((target) => ({ target }) as ResizeObserverEntry);
      if (entries.length > 0) o.cb(entries, o.self);
    }
  });

  function Body() {
    const [wide, setWide] = useState(false); // e.g. the saved folder name arrives
    return <span data-w={wide ? 220 : 150}><button type="button" onClick={() => setWide(true)}>folder</button></span>;
  }
  function Slot({ shape }: { shape: PillShape }) {
    const ref = useRef<HTMLSpanElement | null>(null);
    useVoicePill(ref, shape, 'full');
    return <span className="kb-voicepill" ref={ref}>{shape === 'idle' ? <Body /> : <span data-w={172} />}</span>;
  }
  const swells = () => played.filter((p) => (p.el as HTMLElement).classList.contains('kb-voicepill')).map((p) => p.frames);

  it('the swell starts from the width the idle pill really had, after its body widened by itself', () => {
    const { rerender } = render(<Slot shape="idle" />);
    fireEvent.click(screen.getByRole('button', { name: 'folder' })); // only Body re-renders: 150 → 220 px
    resize();
    rerender(<Slot shape="live" />);
    expect(swells().at(-1)).toEqual([{ width: '220px' }, { width: '172px' }]);
  });

  it('a resize while it swells does not move the resting width (the box is the animation\'s)', () => {
    const { rerender } = render(<Slot shape="idle" />);
    resize();
    rerender(<Slot shape="live" />); // 150 → 172 starts, never finishes here
    midSwell = 160;
    resize();
    rerender(<Slot shape="idle" />);
    expect(swells().at(-1)).toEqual([{ width: '172px' }, { width: '150px' }]);
  });
});
