import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react';
import {
  createAnchorScope,
  type AnchorCaptureOptions,
  type AnchorRestoreOptions,
  type AnchorRestoreResult,
  type ReadingAnchor,
} from './readingAnchor';

export interface UseScopedReadingAnchorOptions {
  chatId: string | null;
  scrollRef: RefObject<HTMLElement | null>;
  /** True once the chat's messages are loaded and mounted in the DOM. */
  ready: boolean;
  /** True when the chat pane is hidden (display: none — scroll geometry is zeroed). */
  hidden?: boolean;
  /** True while another surface temporarily owns scrolling (e.g. in-chat find); pauses capture without restoring on close. */
  pauseCapture?: boolean;
  getAnchor: (chatId: string) => ReadingAnchor | undefined;
  setAnchor: (chatId: string, anchor: ReadingAnchor) => void;
  /** Optional ref synced with stick-to-bottom state (e.g. ChatView's `stick` ref). */
  stickRef?: MutableRefObject<boolean>;
  /** Default when a chat has no saved anchor yet (true = stick to bottom). */
  defaultBottom?: boolean;
  captureOptions?: AnchorCaptureOptions;
  restoreOptions?: Omit<AnchorRestoreOptions, 'defaultBottom'>;
}

export interface ScopedReadingAnchorHandle {
  /**
   * Capture the currently displayed chat's reading anchor into its own store entry.
   * When `expectedChatId` is passed, it acts strictly as a guard against stale tabs
   * and never selects another destination store entry; stale chat IDs or scopes return `null`.
   */
  captureNow: (expectedChatId?: string | null) => ReadingAnchor | null;
  restoreNow: () => AnchorRestoreResult | null;
}

interface BoundCaptureScope {
  chatId: string | null;
  token: number | null;
}

/**
 * Bind scoped capture & restoration of a per-chat reading anchor to a scroll container.
 * - Restores synchronously in `useLayoutEffect` when `chatId` / `ready` / visibility becomes active.
 * - Uses a scope token so an earlier chat or loading state never overwrites a later switch.
 * - Guards against `display: none` (`hidden`) and unloaded (`!ready`) states zeroing saved anchors.
 */
export function useScopedReadingAnchor(options: UseScopedReadingAnchorOptions): ScopedReadingAnchorHandle {
  const {
    chatId,
    scrollRef,
    ready,
    hidden = false,
    pauseCapture = false,
    getAnchor,
    setAnchor,
    stickRef,
    defaultBottom = true,
    captureOptions,
    restoreOptions,
  } = options;

  const scopeRef = useRef<ReturnType<typeof createAnchorScope> | null>(null);
  if (!scopeRef.current) scopeRef.current = createAnchorScope();

  const boundScope = useMemo<BoundCaptureScope>(
    () => ({ chatId, token: null }),
    [chatId, ready, hidden, scrollRef],
  );

  const suppressScrollTopRef = useRef<number | null>(null);
  const suppressSeqRef = useRef(0);
  const latestRef = useRef({
    chatId,
    ready,
    hidden,
    pauseCapture,
    boundScope,
    getAnchor,
    setAnchor,
    stickRef,
    defaultBottom,
    captureOptions,
    restoreOptions,
  });
  latestRef.current = {
    chatId,
    ready,
    hidden,
    pauseCapture,
    boundScope,
    getAnchor,
    setAnchor,
    stickRef,
    defaultBottom,
    captureOptions,
    restoreOptions,
  };

  const restoreNow = useCallback((): AnchorRestoreResult | null => {
    const cur = latestRef.current;
    const el = scrollRef.current;
    const scope = scopeRef.current!;
    if (!cur.chatId || !cur.ready || cur.hidden || !el) {
      cur.boundScope.token = null;
      suppressSeqRef.current += 1;
      suppressScrollTopRef.current = null;
      scope.clear();
      return null;
    }
    const token = scope.claim(cur.chatId);
    const res = scope.restoreIfCurrent(
      cur.chatId,
      token,
      el,
      cur.getAnchor(cur.chatId),
      { ...cur.restoreOptions, defaultBottom: cur.defaultBottom },
    );
    if (res) {
      cur.boundScope.token = token;
      const suppressSeq = ++suppressSeqRef.current;
      suppressScrollTopRef.current = el.scrollTop;
      queueMicrotask(() => {
        if (suppressSeqRef.current === suppressSeq) {
          suppressScrollTopRef.current = null;
        }
      });
      if (cur.stickRef) cur.stickRef.current = res.stickToBottom;
    } else {
      cur.boundScope.token = null;
    }
    return res;
  }, [scrollRef]);

  const captureNow = useCallback(
    (expectedChatId?: string | null): ReadingAnchor | null => {
      const cur = latestRef.current;
      const el = scrollRef.current;
      const scope = scopeRef.current!;
      if (!cur.chatId || !cur.ready || cur.hidden || cur.pauseCapture || !el) return null;
      if (boundScope.chatId !== cur.chatId || boundScope.token === null) return null;
      if (expectedChatId !== undefined && expectedChatId !== cur.chatId) return null;
      const anchor = scope.captureIfCurrent(cur.chatId, boundScope.token, el, cur.captureOptions);
      if (!anchor) return null;
      cur.setAnchor(cur.chatId, anchor);
      if (cur.stickRef) cur.stickRef.current = anchor.stickToBottom;
      return anchor;
    },
    [boundScope, scrollRef],
  );

  useLayoutEffect(() => {
    if (!chatId || !ready || hidden) {
      boundScope.token = null;
      scopeRef.current?.clear();
      return undefined;
    }
    restoreNow();
    return () => {
      boundScope.token = null;
      scopeRef.current?.clear();
    };
  }, [chatId, ready, hidden, boundScope, restoreNow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !chatId || !ready || hidden) return undefined;
    const onScroll = () => {
      const cur = latestRef.current;
      const scope = scopeRef.current!;
      if (
        cur.chatId !== chatId ||
        !cur.ready ||
        cur.hidden ||
        cur.pauseCapture ||
        scrollRef.current !== el ||
        boundScope.token === null ||
        !scope.isCurrent(chatId, boundScope.token)
      ) {
        return;
      }
      if (suppressScrollTopRef.current !== null && el.scrollTop === suppressScrollTopRef.current) return;
      suppressScrollTopRef.current = null;
      const anchor = scope.captureIfCurrent(chatId, boundScope.token, el, cur.captureOptions);
      if (!anchor) return;
      cur.setAnchor(chatId, anchor);
      if (cur.stickRef) cur.stickRef.current = anchor.stickToBottom;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [chatId, ready, hidden, boundScope, scrollRef]);

  return { captureNow, restoreNow };
}
