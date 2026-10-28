import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import type { MotionLevel } from '../ui/motionLevel';
import { ARRIVAL_FADE_MS, ARRIVAL_ID, ENTRANCE_ID, ENTRANCE_RISE_PX, ENTRANCE_SPRING, ENTRANCE_STEP_MS } from './listEntrance';

/*
 * AnimatedList (stage 6, B12) and its guard rail: the rows enter with a stagger on the FIRST load of
 * the list the app opens with — never on a chat switch, a selection, a section switch (the list
 * remounts) or a store update; a new row fades in alone. jsdom has no Web Animations: `animate` is
 * recorded, so these tests pin what plays and on which elements (the look: motion6/build-shots/9-*).
 */

interface Played { el: HTMLElement; frames: Keyframe[]; opts: KeyframeAnimationOptions }
let played: Played[] = [];
beforeEach(() => {
  played = [];
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      played.push({ el: this, frames, opts });
      return { cancel: vi.fn(), finished: new Promise(() => undefined), onfinish: null } as unknown as Animation;
    },
  });
});
afterEach(() => { delete (HTMLElement.prototype as { animate?: unknown }).animate; });

const side = () => screen.getByRole('region', { name: 'Chats' });
const entrances = () => played.filter((p) => p.opts?.id === ENTRANCE_ID);
const arrivals = () => played.filter((p) => p.opts?.id === ARRIVAL_ID);

async function chatsLoaded(motion: MotionLevel = 'full') {
  const user = userEvent.setup();
  const r = renderKb({ world: chatWorld(), prefs: { motion } });
  await within(side()).findByRole('button', { name: /Why is there a logarithm/ });
  return { ...r, user };
}

describe('AnimatedList: the first load of the side list', () => {
  it('full: rows, sub-heads and action rows enter once in document order, +30 ms each, rising 6 px on the 0.26 spring', async () => {
    await chatsLoaded();
    const list = entrances().filter((p) => p.el.matches('[data-entrance]'));
    expect(list.length).toBeGreaterThan(5);
    // Every row of the list takes part, exactly once.
    const rows = [...side().querySelectorAll('[data-entrance]')];
    expect(list.map((p) => p.el)).toEqual(rows);
    expect(list[0]!.el).toHaveTextContent('New chat');
    expect(list.map((p) => p.opts.delay)).toEqual(rows.map((_, i) => Math.min(i, 12) * ENTRANCE_STEP_MS));
    expect(list[0]!.frames).toEqual([{ opacity: 0, transform: `translateY(${ENTRANCE_RISE_PX}px)` }, { opacity: 1, transform: 'none' }]);
    expect(list[0]!.opts).toMatchObject({ duration: ENTRANCE_SPRING.duration, easing: ENTRANCE_SPRING.easing, fill: 'backwards' });
    // The bridge of the open row (New chat) comes with its row, not before it.
    const layer = entrances().find((p) => p.el.classList.contains('kb-tablayer'));
    expect(layer?.opts.delay).toBe(0);
  });

  it('never again: chat switch, selection, section switch (remount) and back, a store update — no entrance', async () => {
    const { user, services } = await chatsLoaded();
    expect(entrances().length).toBeGreaterThan(0);
    played = [];
    const first = within(side()).getByRole('button', { name: /Why is there a logarithm/ });
    const other = within(side()).getByRole('button', { name: /Seminar questions/ });
    await user.click(first);
    await user.click(other);
    await user.keyboard('{Meta>}');
    await user.click(first);
    await user.keyboard('{/Meta}');
    act(() => services.prefs.getState().set({ section: 'materials' }));
    await screen.findByRole('region', { name: 'Materials' });
    act(() => services.prefs.getState().set({ section: 'wiki' }));
    await screen.findByRole('region', { name: 'Wiki' });
    act(() => services.prefs.getState().set({ section: 'chats' }));
    const again = await within(side()).findByRole('button', { name: /Why is there a logarithm/ });
    expect(again).not.toBe(first); // the list did remount on the section switch…
    await act(() => services.chats.getState().loadList());
    expect(entrances()).toEqual([]); // …and still nothing replayed
    expect(arrivals()).toEqual([]);
  });

  it('a new chat fades in alone (140 ms); the other rows do not move', async () => {
    const { services } = await chatsLoaded();
    played = [];
    const [one] = services.chats.getState().list;
    act(() => services.chats.setState((s) => ({ list: [{ ...one!, id: 'c-new', title: 'A brand new chat', pinned: false, updated_at: new Date().toISOString() }, ...s.list] })));
    await within(side()).findByRole('button', { name: /A brand new chat/ });
    expect(entrances()).toEqual([]);
    expect(arrivals().map((p) => p.el.dataset.entrance)).toEqual(['c-new']);
    expect(arrivals()[0]!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(arrivals()[0]!.opts).toMatchObject({ duration: ARRIVAL_FADE_MS });
  });

  it('a list first opened by a section switch shows at once (it never staggers on a switch)', async () => {
    const { services } = await chatsLoaded();
    played = [];
    act(() => services.prefs.getState().set({ section: 'materials' }));
    const mats = await screen.findByRole('region', { name: 'Materials' });
    await within(mats).findByRole('button', { name: /^All materials/ });
    act(() => services.prefs.getState().set({ section: 'wiki' }));
    const wiki = await screen.findByRole('region', { name: 'Wiki' });
    await within(wiki).findByRole('button', { name: /Concepts/ });
    expect(entrances()).toEqual([]);
  });

  // FIX2 S-H1: only the list the app opens with may play — never a list first mounted by a switch.
  it.each([
    ['notifications', 'chats', 'Chats', /Why is there a logarithm/],
    ['graph', 'wiki', 'Wiki', /Concepts/],
  ] as const)('the app opens on %s (no list): a later switch to %s shows the list at once', async (start, to, name, row) => {
    const { services } = renderKb({ world: chatWorld(), prefs: { section: start, motion: 'full' } });
    await screen.findByRole('region', { name: start === 'graph' ? 'Graph' : 'Notifications' });
    await new Promise((r) => setTimeout(r, 200));
    played = [];
    act(() => services.prefs.getState().set({ section: to }));
    const list = await screen.findByRole('region', { name });
    await within(list).findByRole('button', { name: row });
    expect(entrances()).toEqual([]);
  });

  it('the app opens with the side panel closed: opening it later shows the list at once', async () => {
    const { services } = renderKb({ world: chatWorld(), prefs: { sideOpen: false, motion: 'full' } });
    await new Promise((r) => setTimeout(r, 300));
    played = [];
    act(() => services.prefs.getState().set({ sideOpen: true }));
    await within(await screen.findByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ });
    expect(entrances()).toEqual([]);
  });

  it('the start list left before it loaded never plays later (its first mount is gone)', async () => {
    const { services } = renderKb({ world: chatWorld(), prefs: { motion: 'full' } });
    // Leave Chats in the same tick, before the list has loaded.
    act(() => services.prefs.getState().set({ section: 'notifications' }));
    await screen.findByRole('region', { name: 'Notifications' });
    await new Promise((r) => setTimeout(r, 200));
    played = [];
    act(() => services.prefs.getState().set({ section: 'chats' }));
    await within(side()).findByRole('button', { name: /Why is there a logarithm/ });
    expect(entrances()).toEqual([]);
  });

  it('the materials list, when the app opens on it, enters after the library has loaded', async () => {
    renderKb({ world: chatWorld(), prefs: { section: 'materials', motion: 'full' } });
    const mats = await screen.findByRole('region', { name: 'Materials' });
    await within(mats).findByRole('button', { name: /^All materials/ });
    await waitFor(() => expect(entrances().length).toBeGreaterThan(0));
    expect(entrances()[0]!.el).toHaveTextContent('Add material');
  });

  it('the wiki list, when the app opens on it, enters the same way; folded sections take no part', async () => {
    renderKb({ world: chatWorld(), prefs: { section: 'wiki' } });
    const wiki = await screen.findByRole('region', { name: 'Wiki' });
    await within(wiki).findByRole('button', { name: /Concepts/ });
    await waitFor(() => expect(entrances().length).toBeGreaterThan(0));
    expect(entrances().every((p) => !p.el.closest('[inert]'))).toBe(true);
  });

  it.each(['calm', 'off'] as const)('%s: no entrance at all', async (motion) => {
    const { services } = await chatsLoaded(motion);
    expect(entrances()).toEqual([]);
    const [one] = services.chats.getState().list;
    act(() => services.chats.setState((s) => ({ list: [{ ...one!, id: 'c-new', title: 'A brand new chat', pinned: false }, ...s.list] })));
    await within(side()).findByRole('button', { name: /A brand new chat/ });
    // The arrival is a plain short fade: kept at calm, nothing at off.
    expect(arrivals()).toHaveLength(motion === 'calm' ? 1 : 0);
  });
});
