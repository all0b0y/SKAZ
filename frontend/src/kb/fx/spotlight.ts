import type { PointerEvent } from 'react';
import { useMotionLevel, type MotionLevel } from '../ui/motionLevel';

/**
 * SpotlightCard (stage 6, B9; DESIGN-SYSTEM.md decision 30): a very faint light follows the pointer
 * over a CARD while it is hovered — card surfaces only (`.kb-spot`), never list rows.
 *
 * Reference: `.dev/ui-blocks/motion6/motion-v1.js` card b9 — a 160-px radial light of --kb-text at
 * 7 %, opacity 0.2 s on hover; calm / off: no following, a flat 3.5 % tint on the hovered card. The
 * paint lives in CSS (materials.css); this module lights the card a MOUSE is over (`data-spot-lit`,
 * set on its pointer over/out — CSS keys on it, not on :hover, which a pen or a tap leaves stuck,
 * FIX2 C-L7) and moves the light's centre (`--kb-spot-x/y` on the card) for a mouse at «full». Touch
 * and pen never light anything up.
 */
export type SpotMode = 'follow' | 'flat';

export const spotMode = (level: MotionLevel): SpotMode => (level === 'full' ? 'follow' : 'flat');

/**
 * Put the light of the card under the pointer at the pointer. Returns the card it moved, or null
 * (another pointer type, not over a card of this container, or a level that does not follow).
 */
export function spotAt(container: Element, target: EventTarget | null, x: number, y: number,
  pointerType: string, mode: SpotMode): HTMLElement | null {
  if (mode !== 'follow' || pointerType !== 'mouse' || !(target instanceof Element)) return null;
  const card = target.closest<HTMLElement>('.kb-spot');
  if (!card || !container.contains(card)) return null;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--kb-spot-x', `${Math.round(x - r.left)}px`);
  card.style.setProperty('--kb-spot-y', `${Math.round(y - r.top)}px`);
  return card;
}

/** The attribute that lights a card (the CSS keys on it). */
export const SPOT_LIT = 'data-spot-lit';

function cardOf(container: Element, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const card = target.closest<HTMLElement>('.kb-spot');
  return card && container.contains(card) ? card : null;
}

/** A pointer came over `target`: light its card if the pointer is a mouse. Returns the lit card. */
export function spotEnter(container: Element, target: EventTarget | null, pointerType: string): HTMLElement | null {
  if (pointerType !== 'mouse') return null;
  const card = cardOf(container, target);
  card?.setAttribute(SPOT_LIT, '');
  return card;
}

/** A pointer left `target` for `related`: the card goes out unless the pointer stays inside it. */
export function spotLeave(container: Element, target: EventTarget | null, related: EventTarget | null): void {
  const card = cardOf(container, target);
  if (!card || (related instanceof Node && card.contains(related))) return;
  card.removeAttribute(SPOT_LIT);
}

/** Props for the element that holds the cards: its mode for the CSS, and the pointer tracking. */
export function useSpotlight() {
  const mode = spotMode(useMotionLevel());
  return {
    'data-spotlight': mode,
    onPointerOver: (e: PointerEvent<HTMLElement>) => { spotEnter(e.currentTarget, e.target, e.pointerType); },
    onPointerOut: (e: PointerEvent<HTMLElement>) => { spotLeave(e.currentTarget, e.target, e.relatedTarget); },
    onPointerMove: (e: PointerEvent<HTMLElement>) => { spotAt(e.currentTarget, e.target, e.clientX, e.clientY, e.pointerType, mode); },
  } as const;
}
