/*
 * B1 — SKAZ 0.4.1, decision 04: the ChatView half of reply anchors. The host gives this hook the
 * log element (the `role="log"` scroller) and the ordered assistant reply ids; the hook measures
 * one anchor per reply, follows view/scroll changes, applies the reducer's one-shot scroll
 * intents, and answers ↑/↓ only outside editable targets — and only when the conversation owns the
 * viewport (`frozen` while the in-chat find (A4) is open or the chat pane is hidden). ChatView
 * wiring (a separate dispatch) mounts this next to the existing scroller; the hook never touches
 * other panes, and it never scrolls on content growth — the user's manual reading position during
 * streaming stays.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { anchorNavigationDirection } from './keyGuard';
import { measureReplyAnchors } from './measure';
import {
  initialAnchorState,
  reduceAnchors,
  type AnchorEvent,
  type AnchorState,
  type ReplyId,
  type ScrollViewState,
} from './replyAnchors';

export interface UseReplyAnchorsOptions {
  /** The app's reduced-motion level: navigation jumps land instantly instead of smooth. */
  reducedMotion?: boolean;
  /**
   * Another surface owns the conversation's viewport right now — the open in-chat find (A4) or a
   * hidden chat pane — so bare ↑/↓ stay with the page and no explicit navigation runs. The marker
   * keeps following the viewport; only the keys freeze.
   */
  frozen?: boolean;
}

export interface ReplyAnchorsHandle {
  state: AnchorState;
  goToReply(id: ReplyId): void;
  goPrevious(): void;
  goNext(): void;
  returnToLatest(): void;
  /** External navigation (the in-chat find, A4) pointed into `id`. */
  consumeSearch(id: ReplyId): void;
}

function viewOf(el: HTMLElement): ScrollViewState {
  return { scrollTop: el.scrollTop, viewportHeight: el.clientHeight, scrollHeight: el.scrollHeight };
}

function applyScrollTop(el: HTMLElement, top: number, behavior: 'smooth' | 'instant'): void {
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: behavior as ScrollBehavior });
  else el.scrollTop = top;
}

export function useReplyAnchors(
  scrollRef: RefObject<HTMLElement | null>,
  replyIds: readonly ReplyId[],
  options: UseReplyAnchorsOptions = {},
): ReplyAnchorsHandle {
  const [state, setState] = useState<AnchorState>(initialAnchorState);
  const dispatch = useCallback((event: AnchorEvent) => {
    setState((prev) => reduceAnchors(prev, event));
  }, []);
  const idsRef = useRef(replyIds);
  idsRef.current = replyIds;
  const reducedRef = useRef(options.reducedMotion ?? false);
  reducedRef.current = options.reducedMotion ?? false;
  const frozenRef = useRef(options.frozen ?? false);
  frozenRef.current = options.frozen ?? false;

  // The ordered reply ids are host-derived (chat.messages → assistant ids); the reducer's
  // identity guard keeps a fresh array with the same elements a no-op.
  useEffect(() => { dispatch({ type: 'replies', ids: idsRef.current }); }, [replyIds, dispatch]);

  // Apply the one-shot intent as a layout effect: before paint, so a scroll event racing the
  // click cannot clear it unapplied. The view snapshot that follows (this one, or the scroll it
  // causes) consumes it in the reducer.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const intent = state.intent;
    if (!el || intent.kind === 'none') return;
    const top = intent.kind === 'jumpToReply' ? intent.top : el.scrollHeight;
    applyScrollTop(el, top, reducedRef.current ? 'instant' : intent.behavior);
    dispatch({ type: 'view', view: viewOf(el) });
  }, [state.intent, scrollRef, dispatch]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measureNow = () => {
      for (const { id, measurement } of measureReplyAnchors(el, idsRef.current)) {
        dispatch({ type: 'measured', id, measurement });
      }
      dispatch({ type: 'view', view: viewOf(el) });
    };
    const onScroll = () => dispatch({ type: 'view', view: viewOf(el) });
    const onKeyDown = (event: KeyboardEvent) => {
      if (frozenRef.current) return;
      const direction = anchorNavigationDirection(event, event.target);
      if (direction === null) return;
      event.preventDefault();
      dispatch({ type: 'keyboard', direction });
    };
    measureNow();
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('keydown', onKeyDown);

    // Streamed text, reveals and resizes move anchors: read the layout once per frame, not once
    // per token batch (the ScrollEdges pattern). Resizes of the scroller and of its content
    // wrappers are watched, re-synced when its children change.
    let frame = 0;
    const onMutation = (records: MutationRecord[]) => {
      if (records.some((r) => r.type === 'childList' && r.target === el)) watchContent();
      if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; measureNow(); });
    };
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(onMutation);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureNow);
    const watched = new Set<Element>();
    const watchContent = () => {
      if (!ro) return;
      const now = new Set<Element>([el, ...Array.from(el.children)]);
      for (const node of watched) if (!now.has(node)) { ro.unobserve(node); watched.delete(node); }
      for (const node of now) if (!watched.has(node)) { ro.observe(node); watched.add(node); }
    };
    watchContent();
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('keydown', onKeyDown);
      mo?.disconnect();
      ro?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollRef, dispatch]);

  const goToReply = useCallback((id: ReplyId) => dispatch({ type: 'select', id }), [dispatch]);
  const goPrevious = useCallback(() => dispatch({ type: 'keyboard', direction: 'previous' }), [dispatch]);
  const goNext = useCallback(() => dispatch({ type: 'keyboard', direction: 'next' }), [dispatch]);
  const returnToLatest = useCallback(() => dispatch({ type: 'returnToLatest' }), [dispatch]);
  // A4 owns exact-match scrolling: consuming its navigation never jumps. Sync the marker from the
  // viewport as it stands after A4's own scroll — idempotent, since scroll events keep the state
  // current anyway, and harmless for repeated matches inside a single reply.
  const consumeSearch = useCallback((id: ReplyId) => {
    dispatch({ type: 'search', id });
    const el = scrollRef.current;
    if (el) dispatch({ type: 'view', view: viewOf(el) });
  }, [dispatch, scrollRef]);

  return { state, goToReply, goPrevious, goNext, returnToLatest, consumeSearch };
}
