import { useLayoutEffect, type RefObject } from 'react';
import { useServices } from '../state/context';
import { useMotionLevel } from '../ui/motionLevel';
import { springEasing } from '../ui/ActiveTab';
import { sessionSlot } from './session';

/**
 * AnimatedList (stage 6, B12; DESIGN-SYSTEM.md decision 30 and its guard rail): the rows of a side
 * list enter once with a short stagger — on the FIRST load of the list the app opens with (see START_LIST), and never
 * again: not on a section switch (the list remounts, the session remembers), not on a chat/page
 * switch or a selection (the rows stay mounted, nothing here runs), not on a store update.
 * A row that arrives later (a new chat, a new material) fades in alone; nothing else moves.
 *
 * Reference: `.dev/ui-blocks/motion6/motion-v1.js` card b12 — each row: opacity + 6 px rise on the
 * spring visualDuration 0.26 / bounce 0, +30 ms per row; a new row: 140 ms fade. Entrances are «full»
 * only (motion table): calm and off show the list at once; the arrival fade stays at calm (it is a
 * plain short fade), off = nothing.
 *
 * Items are the host's `[data-entrance]` elements in document order (rows, sub-heads, action rows);
 * a row's value is its key (`data-entrance={id}`), the key an arrival is found by. Items in a folded
 * (inert) body and items below the host's visible box take no part.
 */
export const ENTRANCE_STEP_MS = 30;
export const ENTRANCE_RISE_PX = 6;
/** The stagger stops growing here: a long list never waits for its last visible row. */
export const ENTRANCE_MAX_STEPS = 12;
export const ENTRANCE_SPRING = springEasing(0.26, 0);
export const ARRIVAL_FADE_MS = 140;
/** Animation ids (`Animation.id`), so a test or a probe can tell these from other motion. */
export const ENTRANCE_ID = 'kb-list-entrance';
export const ARRIVAL_ID = 'kb-list-arrival';

/**
 * The list the app opens with (FIX2 S-H1): decided once, when the shell first renders — the side
 * panel's section if the panel is shown and that section has a list, otherwise none. Only that list,
 * on its first load, may play the entrance; the claim is dropped as soon as the panel's section
 * changes or the panel closes (a list first mounted by a switch never staggers), and once it played.
 */
const START_LIST = 'list-entrance:start';
/** The side sections that have an animated list (their `useListEntrance` ids). */
export const ENTRANCE_LISTS: ReadonlySet<string> = new Set(['chats', 'materials', 'wiki']);

interface StartClaim { id: string | null; shown: string | null }

function startClaim(owner: object, shown: string | null): StartClaim {
  return sessionSlot<StartClaim>(owner, START_LIST, () => ({ id: shown !== null && ENTRANCE_LISTS.has(shown) ? shown : null, shown })).value;
}

/**
 * The shell's half of S-H1. `shown` = the side panel's section while the panel is on screen, else
 * null. The first call of the session decides the start list; any later change of `shown` drops it.
 */
export function useStartList(shown: string | null): void {
  const services = useServices();
  startClaim(services, shown); // the first render decides (idempotent: a re-render finds the slot)
  useLayoutEffect(() => {
    const claim = startClaim(services, shown);
    if (claim.shown !== shown) { claim.id = null; claim.shown = shown; }
  }, [services, shown]);
}

/** True once, for the start list's first load; false for every other list and every later load. */
function takeStart(owner: object, id: string): boolean {
  const claim = startClaim(owner, null);
  if (claim.id !== id) return false;
  claim.id = null;
  return true;
}

function items(host: HTMLElement): HTMLElement[] {
  const all = [...host.querySelectorAll<HTMLElement>('[data-entrance]')].filter((el) => !el.closest('[inert]'));
  const box = host.getBoundingClientRect();
  if (box.height <= 0) return all; // no layout (jsdom, a hidden panel): every item, capped below
  return all.filter((el) => el.getBoundingClientRect().top < box.bottom);
}

function playEntrance(host: HTMLElement) {
  const list = items(host);
  const delayOf = (i: number) => Math.min(i, ENTRANCE_MAX_STEPS) * ENTRANCE_STEP_MS;
  const frames = [{ opacity: 0, transform: `translateY(${ENTRANCE_RISE_PX}px)` }, { opacity: 1, transform: 'none' }];
  const timing = (i: number): KeyframeAnimationOptions => ({
    duration: ENTRANCE_SPRING.duration, easing: ENTRANCE_SPRING.easing, delay: delayOf(i), fill: 'backwards', id: ENTRANCE_ID,
  });
  list.forEach((el, i) => { if (typeof el.animate === 'function') el.animate(frames, timing(i)); });
  // The open row's tab (bridge / soft tile) is drawn apart from its row: it comes with that row.
  for (const layer of host.querySelectorAll<HTMLElement>('.kb-tablayer')) {
    const open = layer.parentElement?.querySelector<HTMLElement>('[data-tab-key].is-current');
    const at = open ? list.findIndex((el) => el === open || el.contains(open)) : -1;
    if (at >= 0 && typeof layer.animate === 'function') layer.animate(frames, timing(at));
  }
}

function playArrivals(host: HTMLElement, keys: ReadonlySet<string>) {
  for (const el of host.querySelectorAll<HTMLElement>('[data-entrance]')) {
    if (!keys.has(el.dataset.entrance ?? '') || typeof el.animate !== 'function') continue;
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ARRIVAL_FADE_MS, easing: 'ease-out', id: ARRIVAL_ID });
  }
}

/**
 * @param id     the list's name for the session ('chats', 'materials', 'wiki').
 * @param host   the list's scroll box.
 * @param ready  the list's data has loaded (rows, or an honest empty/error state, are on screen).
 * @param keys   every row key the data holds (not only the rows that are unfolded).
 */
export function useListEntrance(id: string, host: RefObject<HTMLElement | null>, ready: boolean, keys: readonly string[]): void {
  const services = useServices();
  const level = useMotionLevel();
  const signature = keys.join('\n');
  useLayoutEffect(() => {
    const el = host.current;
    if (!ready || !el) return;
    const { value: known, fresh } = sessionSlot(services, `list-entrance:${id}`, () => new Set<string>());
    if (fresh) {
      keys.forEach((k) => known.add(k));
      if (takeStart(services, id) && level === 'full') playEntrance(el);
      return;
    }
    const arrived = new Set(keys.filter((k) => !known.has(k)));
    arrived.forEach((k) => known.add(k));
    if (arrived.size > 0 && level !== 'off') playArrivals(el, arrived);
    // `keys` is read through its signature: a new array with the same rows changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, id, host, ready, signature, level]);
}
