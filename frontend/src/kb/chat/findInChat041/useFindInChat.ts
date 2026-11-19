import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { findChatMatches, moveChatMatch, retainChatMatch, type ChatFindResult } from './findMatches';
import { createChatHighlights, createRenderedChatReader, revealChatMatch, type RenderedChatTextRun } from './renderedChat';

export interface FindInChatOptions {
  /** Null when no chat is open or the chat pane is hidden. */
  chatId: string | null;
  scopeRef: RefObject<HTMLElement>;
  scrollRef: RefObject<HTMLElement>;
  reducedMotion: boolean;
  /** Releases host scrolling at the saved position before the panel changes layout. May return cleanup. */
  beforeOpen?: (position: ScrollToOptions) => (() => void) | undefined;
}

export interface FindInChatController extends ChatFindResult {
  isOpen: boolean;
  query: string;
  inputRef: RefObject<HTMLInputElement>;
  setQuery: (query: string) => void;
  move: (direction: 1 | -1) => void;
  close: () => void;
}

const EMPTY: ChatFindResult = { matches: [], activeMatch: null, activeIndex: -1 };

type PanelState = { chatId: string; query: string; result: ChatFindResult };

function keepFocusAndSelection(scope: HTMLElement, scroll: HTMLElement) {
  const doc = scope.ownerDocument;
  const view = doc.defaultView!;
  const focused = doc.activeElement;
  const target = focused instanceof view.HTMLElement && scope.contains(focused) ? focused : scroll;
  const textField = target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement ? target : null;
  const start = textField?.selectionStart;
  const end = textField?.selectionEnd;
  const direction = textField?.selectionDirection;
  const selection = doc.getSelection();
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  const offsets = selection && anchor && focus && scope.contains(anchor) && scope.contains(focus)
    ? [selection.anchorOffset, selection.focusOffset] as const : null;
  const length = (node: Node) => node instanceof view.Text ? node.length : node.childNodes.length;
  return () => {
    if (scope.contains(target)) target.focus({ preventScroll: true });
    if (doc.activeElement !== target) scroll.focus({ preventScroll: true });
    if (textField && doc.activeElement === textField && start != null && end != null) {
      textField.setSelectionRange(start, end, direction ?? 'none');
    } else if (selection && offsets && anchor && focus && scope.contains(anchor) && scope.contains(focus)
      && offsets[0] <= length(anchor) && offsets[1] <= length(focus)) {
      selection.setBaseAndExtent(anchor, offsets[0], focus, offsets[1]);
    }
  };
}

function startFindSession(
  scope: HTMLElement,
  scroll: HTMLElement,
  publish: (query: string, result: ChatFindResult) => void,
  shouldReduceMotion: () => boolean,
  beforeOpen?: FindInChatOptions['beforeOpen'],
) {
  const doc = scroll.ownerDocument;
  const view = doc.defaultView!;
  const highlights = createChatHighlights(doc);
  const renderedChat = createRenderedChatReader(scroll);
  const restoreFocus = keepFocusAndSelection(scope, scroll);
  const openingPosition: ScrollToOptions = { top: scroll.scrollTop, left: scroll.scrollLeft, behavior: 'instant' };
  const positions = new Map<HTMLElement, ScrollToOptions>([[scroll, openingPosition]]);
  const finishHandoff = beforeOpen?.(openingPosition);
  const rememberScroll = (el: HTMLElement) => {
    if (!positions.has(el)) positions.set(el, { top: el.scrollTop, left: el.scrollLeft, behavior: 'instant' });
  };

  let frame: number | null = null;
  let query = '';
  let runs: RenderedChatTextRun[] = [];
  let result = EMPTY;
  let scrolledConversation = false;

  const show = (reveal: boolean) => {
    highlights.paint(runs, result);
    publish(query, result);
    if (reveal && result.activeMatch) {
      const reduced = shouldReduceMotion() || view.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      revealChatMatch(scroll, runs, result.activeMatch, reduced ? 'instant' : 'smooth', (element) => {
        rememberScroll(element);
        if (element === scroll) {
          finishHandoff?.();
          scrolledConversation = true;
        }
      });
    }
  };

  const readResult = (previous?: ChatFindResult) => {
    runs = query.trim() ? renderedChat.read() : [];
    return retainChatMatch(findChatMatches(runs, query), previous);
  };

  const scheduleRefresh = () => {
    if (!query.trim() || frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      renderedChat.invalidate(observer.takeRecords());
      const activeId = result.activeMatch?.id;
      result = readResult(result);
      show(activeId !== result.activeMatch?.id);
    });
  };
  const observer = new view.MutationObserver((records) => {
    renderedChat.invalidate(records);
    scheduleRefresh();
  });
  observer.observe(scroll, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'data-message-id'],
  });
  for (let ancestor = scroll.parentElement; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true });
  }
  const onResize = () => {
    renderedChat.clear();
    scheduleRefresh();
  };
  view.addEventListener('resize', onResize);
  publish(query, result);

  return {
    setQuery(next: string) {
      if (next === query) return;
      query = next;
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null;
      renderedChat.invalidate(observer.takeRecords());
      result = readResult();
      show(true);
    },
    move(direction: 1 | -1) {
      // A key event can arrive between a streaming React commit and the observer's frame.
      const records = observer.takeRecords();
      if (records.length || frame !== null) {
        if (frame !== null) view.cancelAnimationFrame(frame);
        frame = null;
        renderedChat.invalidate(records);
        result = readResult(result);
      }
      result = moveChatMatch(result, direction);
      show(true);
    },
    dispose(restore: boolean) {
      finishHandoff?.();
      observer.disconnect();
      view.removeEventListener('resize', onResize);
      if (frame !== null) view.cancelAnimationFrame(frame);
      highlights.clear();
      if (restore) {
        return () => {
          restoreFocus();
          for (const [element, position] of positions) if (scope.contains(element)) element.scrollTo(position);
        };
      }
      if (scrolledConversation && scroll.isConnected) {
        // A smooth scroll from this session must not continue into the newly selected chat.
        scroll.scrollTo({ top: scroll.scrollTop, left: scroll.scrollLeft, behavior: 'instant' });
      }
    },
  };
}

/** Attach current-chat find to a stable chat scope and its conversation scroller. */
export function useFindInChat({ chatId, scopeRef, scrollRef, reducedMotion, beforeOpen }: FindInChatOptions): FindInChatController {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduce = useRef(reducedMotion);
  const session = useRef<ReturnType<typeof startFindSession> | null>(null);
  const restoreOnClose = useRef<(() => void) | undefined>(undefined);
  const isOpen = panel !== null && panel.chatId === chatId;

  useLayoutEffect(() => { reduce.current = reducedMotion; }, [reducedMotion]);

  const close = useCallback(() => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    restoreOnClose.current = current.dispose(true);
    setPanel(null);
  }, []);

  useLayoutEffect(() => {
    setPanel(null);
    const scope = scopeRef.current;
    const scroll = scrollRef.current;
    if (chatId === null || !scope || !scroll) return;
    const doc = scope.ownerDocument;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape' && session.current) {
        // Modal makes the background inert and handles Escape on window if focus falls to body.
        if (scope.closest('[inert]')) return;
        event.preventDefault();
        close();
        return;
      }
      const target = event.target;
      const inScope = target instanceof Node && scope.contains(target);
      const chatSelection = target === doc.body && scope.contains(doc.getSelection()?.anchorNode ?? null);
      if (!inScope && !chatSelection) return;
      const find = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        && (event.key.toLowerCase() === 'f' || event.code === 'KeyF');
      if (find) {
        event.preventDefault();
        if (session.current) {
          inputRef.current?.focus({ preventScroll: true });
          inputRef.current?.select();
        } else {
          session.current = startFindSession(scope, scroll,
            (query, result) => setPanel({ chatId, query, result }), () => reduce.current, beforeOpen);
        }
      }
    };
    doc.addEventListener('keydown', onKey);
    return () => {
      doc.removeEventListener('keydown', onKey);
      session.current?.dispose(false);
      session.current = null;
      restoreOnClose.current = undefined;
    };
  }, [chatId, scopeRef, scrollRef, beforeOpen, close]);

  useLayoutEffect(() => {
    if (isOpen) {
      inputRef.current?.focus({ preventScroll: true });
    } else {
      // The scroller has its original dimensions again after the panel is removed.
      restoreOnClose.current?.();
      restoreOnClose.current = undefined;
    }
  }, [isOpen]);

  return {
    isOpen,
    query: isOpen ? panel.query : '',
    ...(isOpen ? panel.result : EMPTY),
    inputRef,
    close,
    setQuery: (query) => session.current?.setQuery(query),
    move: (direction) => session.current?.move(direction),
  };
}
