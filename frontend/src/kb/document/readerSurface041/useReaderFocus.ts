import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useServices, useUi } from '../../state/context';
import type { ReaderFocusTarget, RightView, WikiLinkFocus } from '../../state/document';
import { findScrollTarget } from '../useScrollTarget';

function matchingWikiLinks(body: HTMLElement, { href, label }: Pick<WikiLinkFocus, 'href' | 'label'>) {
  return [...body.querySelectorAll<HTMLButtonElement>('button[data-reader-wiki-link]')]
    .filter((link) => link.dataset.readerWikiLink === href && link.textContent === label);
}

export function wikiLinkFocus(body: HTMLElement, link: HTMLButtonElement, href: string): ReaderFocusTarget {
  const identity = { href, label: link.textContent ?? '' };
  return { wikiLink: { ...identity, occurrence: matchingWikiLinks(body, identity).indexOf(link) } };
}

function destinationIn(panel: HTMLElement, body: HTMLElement, destination: ReaderFocusTarget, targetKey: string | null) {
  if (destination === 'heading') return null;
  if (destination === 'notes') return panel.querySelector<HTMLButtonElement>('button[data-reader-action="notes"]');
  if (destination === 'transcript') return panel.querySelector<HTMLButtonElement>('button[data-reader-action="transcript"]');
  if (destination === 'target') {
    const fragment = targetKey ? findScrollTarget(body, targetKey) : null;
    return fragment?.querySelector<HTMLElement>('mark.kb-quote, button.kb-fix.is-quote') ?? fragment;
  }
  if ('wikiLink' in destination) return matchingWikiLinks(body, destination.wikiLink)[destination.wikiLink.occurrence] ?? null;
  const group = destination.blockId === null
    ? body.querySelector('[data-reader-sources]')
    : findScrollTarget(body, destination.blockId);
  return [...(group?.querySelectorAll<HTMLButtonElement>('button[data-reader-citation]') ?? [])]
    .find((button) => button.dataset.readerCitation === destination.materialId) ?? null;
}

function focusVisible(element: HTMLElement | null | undefined, preventScroll = false): boolean {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')
    || element.checkVisibility?.({ visibilityProperty: true }) === false) return false;
  if (element.tabIndex < 0) element.tabIndex = -1;
  // A restored citation stays closed, like a citation that just handled Escape.
  const citation = element.matches('button[data-reader-citation]');
  if (citation) element.dataset.readerRestoringFocus = '';
  element.focus({ preventScroll });
  if (citation) delete element.dataset.readerRestoringFocus;
  return document.activeElement === element;
}

/** The chat is visible again after the shell commits the reader close. */
export function useReaderCloseFocus(appRef: RefObject<HTMLElement | null>, right: RightView | null) {
  const { chats } = useServices();
  const previous = useRef<RightView | null>(null);
  useLayoutEffect(() => {
    const closed = previous.current;
    previous.current = right;
    if (right || closed?.kind !== 'doc' || !closed.closeFocus || document.activeElement !== document.body) return;
    const { chatId, trigger } = closed.closeFocus;
    const app = appRef.current;
    const chat = app?.querySelector<HTMLElement>('[data-pane="center"][aria-label="Chat"]');
    if (chats.getState().currentId === chatId && chat?.contains(trigger) && focusVisible(trigger)) return;
    if (focusVisible(chat?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'), true)) return;
    if (focusVisible(chat?.querySelector<HTMLElement>('[role="log"]'), true)) return;
    if (focusVisible(chat, true)) return;
    focusVisible(app?.querySelector<HTMLElement>('[data-pane="rail"] [aria-current="page"]'), true);
  }, [appRef, chats, right]);
}

/** Explicit reader navigation can park focus on the panel while its content mounts. */
export function useReaderFocus(bodyRef: RefObject<HTMLElement | null>, nonce: number, ready: boolean,
  targetKey: string | null, checkingTranscript = false) {
  const request = useUi(({ right }) =>
    (right?.kind === 'doc' || right?.kind === 'wikifile') && right.nonce === nonce ? right.focus : undefined);
  const handled = useRef<{ nonce: number; waiting: boolean } | null>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const panel = body?.closest<HTMLElement>('#kb-doc');
    if (!request || !body || !panel) return;
    const active = document.activeElement;
    if (handled.current?.nonce === nonce) {
      // The user can tab or click elsewhere while the content is loading.
      if (!handled.current.waiting || active !== panel) {
        handled.current.waiting = false;
        return;
      }
    } else if (active !== document.body && active !== panel && active !== request.origin) {
      handled.current = { nonce, waiting: false };
      return;
    }

    const { destination } = request;
    if (!ready || (destination === 'transcript' && checkingTranscript)) {
      handled.current = { nonce, waiting: true };
      if (active !== panel) panel.focus({ preventScroll: true });
      const cancelOnFocusMove = (event: FocusEvent) => {
        if (event.target !== panel && handled.current?.nonce === nonce) handled.current.waiting = false;
      };
      document.addEventListener('focusin', cancelOnFocusMove, true);
      return () => document.removeEventListener('focusin', cancelOnFocusMove, true);
    }

    handled.current = { nonce, waiting: false };
    const preferred = destinationIn(panel, body, destination, targetKey);
    // The scroll-target effect already brings the fragment into view and marks it.
    if (focusVisible(preferred, destination === 'target')) return;
    const fallback = body.querySelector<HTMLElement>('.kb-doc__title') ?? body.querySelector<HTMLElement>('.kb-banner--error');
    if (!focusVisible(fallback)) panel.focus({ preventScroll: true });
  }, [bodyRef, checkingTranscript, nonce, ready, request, targetKey]);
  return request?.destination;
}
