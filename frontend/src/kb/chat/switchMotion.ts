import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useServices } from '../state/context';
import { useMotionLevel } from '../ui/motionLevel';
import { springEasing } from '../ui/ActiveTab';
import { sideChats, switchDir } from './sideOrder';

/** The thread rises this far (× direction) as it comes (decision 25 «content follows the direction»). */
export const FOLLOW_PX = 12;
export const FOLLOW_DELAY_MS = 60;
export const TITLE_FADE_MS = 160;
export const TITLE_DELAY_MS = 40;
/**
 * The thread's spring: SPRING_LARGE's parameters (visualDuration 0.32, no bounce) through the mock's
 * spring (`springEasing`, ω = 6.6 / vd), played by the Web Animations API. Same parameters, not the
 * same curve as motion's SPRING_LARGE — the mock's feel is the approved one (FIX1 R9).
 */
const THREAD_SPRING = springEasing(0.32, 0);

/**
 * When the open chat changes, its content follows the tab (decision 25): the thread enters from
 * 12 px × dir below/above (+1 = the new row is below the old one in the side list) with the large
 * spring, after 60 ms; the header title crossfades in 160 ms after 40 ms. At «calm» both only fade
 * (160 ms); at «off» nothing moves. Nothing plays when the chat does not change, when the chat view
 * is hidden, or when the new chat is the one the empty view just created (its burn-out plays).
 * Elements are animated in place — nothing is remounted.
 */
export function useFollowSwitch(currentId: string | null, hidden: boolean,
  thread: RefObject<HTMLElement | null>, title: RefObject<HTMLElement | null>) {
  const { chats } = useServices();
  const level = useMotionLevel();
  const before = useRef(currentId);
  const running = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const from = before.current;
    before.current = currentId;
    if (from === currentId) return;
    running.current.forEach((a) => a.cancel());
    running.current = [];
    if (hidden || level === 'off') return;
    const state = chats.getState();
    if (from === null && currentId && state.chats[currentId]?.chat?.messages.length === 0) return;
    const t = thread.current;
    const h = title.current;
    const dir = switchDir(sideChats(state.list).order, from, currentId);
    const played: Animation[] = [];
    if (t && typeof t.animate === 'function') {
      played.push(level === 'full'
        ? t.animate([{ opacity: 0, transform: `translateY(${FOLLOW_PX * dir}px)` }, { opacity: 1, transform: 'none' }],
          { duration: THREAD_SPRING.duration, delay: FOLLOW_DELAY_MS, easing: THREAD_SPRING.easing, fill: 'backwards' })
        : t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TITLE_FADE_MS, easing: 'ease-out', fill: 'backwards' }));
    }
    if (h && typeof h.animate === 'function') {
      played.push(h.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: TITLE_FADE_MS, delay: level === 'full' ? TITLE_DELAY_MS : 0, easing: 'ease-out', fill: 'backwards' }));
    }
    running.current = played;
  }, [chats, currentId, hidden, level, thread, title]);

  useLayoutEffect(() => () => running.current.forEach((a) => a.cancel()), []);
}
