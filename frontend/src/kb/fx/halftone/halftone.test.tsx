import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { renderKb } from '../../test/renderKb';
import { docWorld } from '../../test/fakeBridge';
import type { MotionLevel } from '../../ui/motionLevel';
import { HALFTONE_DONE_S, HALFTONE_GROW_S, dotGrowth, dotRadius, drawHalftone, halftoneDots } from './halftone';
import { HALFTONE_FADE_MS } from './HalftoneArt';

/*
 * HalftoneReveal (stage 6, B11): the empty-state art draws itself once from the centre, then holds
 * still. jsdom has no canvas: the painter is tested on a recording context, the component on what it
 * renders and plays (the pixels: motion6/build-shots/11-*).
 */

describe('the halftone art', () => {
  const dots = halftoneDots(200, 116);
  it('three sheets of dots inside the canvas, one accent (title) stripe, distances 0..1', () => {
    expect(dots.length).toBeGreaterThan(300);
    expect(dots.every((d) => d.x >= 0 && d.x <= 200 && d.y >= 0 && d.y <= 116)).toBe(true);
    const accent = dots.filter((d) => d.accent);
    expect(accent.length).toBeGreaterThan(3);
    // The accent is one stripe: its dots share (about) one row, near the top of the top sheet.
    expect(Math.max(...accent.map((d) => d.y)) - Math.min(...accent.map((d) => d.y))).toBeLessThanOrEqual(4);
    expect(dots.every((d) => d.d >= 0 && d.d <= 1)).toBe(true);
    // Paper is nearly white, edges and stripes carry the drawing.
    expect(dots.filter((d) => d.tone > 0.5).length).toBeGreaterThan(50);
    expect(dots.filter((d) => d.tone < 0.2).length).toBeGreaterThan(100);
  });

  it('grows from the centre outwards and is complete at 0.9 s', () => {
    expect(dotGrowth(0, 0)).toBe(0);
    expect(dotGrowth(HALFTONE_GROW_S, 0)).toBe(1);
    expect(dotGrowth(0.3, 0.9)).toBe(0); // a far dot has not started when the centre is done
    expect(dotGrowth(0.5, 0.2)).toBeGreaterThan(dotGrowth(0.5, 0.6));
    expect(dots.every((d) => dotGrowth(HALFTONE_DONE_S, d.d) === 1)).toBe(true);
  });

  it('draws nothing at t = 0, every dot once complete, at its tone radius; the accent stripe in the FX accent', () => {
    const fills: string[] = [];
    const radii: number[] = [];
    const ctx = {
      fillStyle: '', beginPath: vi.fn(), fill: vi.fn(function (this: { fillStyle: string }) { fills.push(this.fillStyle); }),
      arc: vi.fn((_x: number, _y: number, r: number) => radii.push(r)),
    } as unknown as CanvasRenderingContext2D;
    const colors = { ink: [10, 20, 30], accent: [200, 100, 50] } as const;
    expect(drawHalftone(ctx, dots, 0, colors)).toBe(0);
    expect(drawHalftone(ctx, dots, HALFTONE_DONE_S, colors)).toBe(dots.length);
    expect(radii).toEqual(dots.map((d) => dotRadius(d.tone)));
    expect(fills.filter((f) => f.startsWith('rgba(200,100,50')).length).toBe(dots.filter((d) => d.accent).length);
  });

  it('scales for the compact (side panel) size', () => {
    const small = halftoneDots(140, 80, 0.7);
    expect(small.length).toBeGreaterThan(300);
    expect(dotRadius(1, 0.7)).toBeCloseTo(2.1 * 0.7);
  });
});

interface Played { el: HTMLElement; frames: Keyframe[]; opts: KeyframeAnimationOptions }
let played: Played[] = [];
beforeEach(() => {
  played = [];
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      played.push({ el: this, frames, opts });
      return { cancel: vi.fn(), finished: new Promise(() => undefined) } as unknown as Animation;
    },
  });
});
afterEach(() => { delete (HTMLElement.prototype as { animate?: unknown }).animate; });

const side = (name: string) => screen.getByRole('region', { name });

async function emptyApp(motion: MotionLevel) {
  // docWorld has materials and no chats; its wiki pages go too, for the empty wiki.
  const world = docWorld();
  world.pages = [];
  const r = renderKb({ world, prefs: { motion } });
  await within(side('Chats')).findByText('No chats yet');
  return r;
}

describe('HalftoneReveal in the empty states', () => {
  it('full: the chat list’s empty state draws the art once (no icon, no dither field), then it is still', async () => {
    await emptyApp('full');
    const empty = within(side('Chats')).getByText('No chats yet').closest('.kb-empty')!;
    const art = empty.querySelector('.kb-empty__art')!;
    expect(art).toHaveAttribute('aria-hidden', 'true');
    expect(art.querySelector('canvas.kb-fx-halftone')).toBeInTheDocument();
    expect(empty.querySelector('.kb-empty__icon, .kb-empty__field')).toBeNull();
    expect(art).toHaveAttribute('data-reveal', 'draw');
    await waitFor(() => expect(art).toHaveAttribute('data-reveal', 'still'), { timeout: 3000 });
  });

  it('once per session: after a section switch and back the art is the still image', async () => {
    const { services } = await emptyApp('full');
    act(() => services.prefs.getState().set({ section: 'wiki' }));
    const wiki = await screen.findByRole('region', { name: 'Wiki' });
    const wikiArt = (await within(wiki).findByText('The wiki is empty')).closest('.kb-empty')!.querySelector('.kb-empty__art');
    expect(wikiArt).toHaveAttribute('data-reveal', 'draw'); // its own first showing
    await new Promise((r) => setTimeout(r, 150));
    act(() => services.prefs.getState().set({ section: 'chats' }));
    const again = (await within(side('Chats')).findByText('No chats yet')).closest('.kb-empty')!.querySelector('.kb-empty__art');
    expect(again).toHaveAttribute('data-reveal', 'still');
  });

  it('calm: the finished image fades in (200 ms); off: the still image, nothing plays', async () => {
    await emptyApp('calm');
    const art = within(side('Chats')).getByText('No chats yet').closest('.kb-empty')!.querySelector<HTMLElement>('.kb-empty__art')!;
    expect(art).toHaveAttribute('data-reveal', 'fade');
    const fade = played.find((p) => p.el === art);
    expect(fade?.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(fade?.opts).toMatchObject({ duration: HALFTONE_FADE_MS });
  });

  it('off: still, nothing plays', async () => {
    await emptyApp('off');
    const art = within(side('Chats')).getByText('No chats yet').closest('.kb-empty')!.querySelector<HTMLElement>('.kb-empty__art')!;
    expect(art).toHaveAttribute('data-reveal', 'still');
    expect(played.some((p) => p.el === art)).toBe(false);
  });

  it('All materials with no materials: the art above «No materials yet» and its Add button', async () => {
    const world = docWorld();
    world.materials = [];
    const r = renderKb({ world, prefs: { motion: 'full' } });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().showCenter('materials'));
    const all = await screen.findByRole('region', { name: 'All materials' });
    const empty = (await within(all).findByText('No materials yet')).closest('.kb-empty')!;
    expect(empty.querySelector('.kb-empty__art:not(.kb-empty__art--compact) canvas')).toBeInTheDocument();
    expect(within(empty as HTMLElement).getByRole('button', { name: 'Add material' })).toBeInTheDocument();
  });

  it('an empty folder in the materials panel shows the compact art', async () => {
    const world = docWorld();
    const r = renderKb({ world, prefs: { motion: 'full', section: 'materials' } });
    const mats = await screen.findByRole('region', { name: 'Materials' });
    await within(mats).findByRole('button', { name: /^All materials/ });
    const empty = world.folders.find((f) => !world.materials.some((m) => m.folder_id === f.id));
    expect(empty).toBeTruthy();
    await act(() => r.services.library.getState().openFolder(empty!.id));
    const state = (await within(mats).findByText('No materials in this folder')).closest('.kb-empty')!;
    expect(state.querySelector('.kb-empty__art--compact canvas')).toBeInTheDocument();
  });
});
