/*
 * B1 — SKAZ 0.4.1, decision 04 §5: when the focus is not in an input field, ↑/↓ move to the
 * previous/next answer. Only bare arrows count: Shift+Arrow stays the native selection and an
 * event another handler already consumed is never handled again. The guard mirrors
 * QuestionBlock's option-key guard, so an edit-in-place question field inside the log keeps its
 * arrows. The composer, dictation controls, the find panel and other panes live outside the chat
 * log and never reach this guard — the host attaches the listener to the log container only.
 */

export interface NavigationKeyInput {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** Shift+Arrow is the native selection extension: the anchors never take it. */
  shiftKey?: boolean;
  /** Another handler already consumed this event: never act on it a second time. */
  defaultPrevented?: boolean;
}

/**
 * Bare ↑/↓ only. With any modifier — or on an event some earlier handler already consumed —
 * the keys belong to the browser, the OS or that handler, not to anchor navigation.
 */
export function navigationDirection(event: NavigationKeyInput): 'previous' | 'next' | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.defaultPrevented) return null;
  if (event.key === 'ArrowUp') return 'previous';
  if (event.key === 'ArrowDown') return 'next';
  return null;
}

/** Is this event target a field the user is typing into? Anchor navigation must not touch it. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"]') !== null) return true;
  return target instanceof HTMLElement && target.isContentEditable === true;
}

/**
 * What the chat log's keydown handler should do with this event: `previous`/`next` when it is a
 * bare ↑/↓ outside any editable target, or null when the keys are not ours.
 */
export function anchorNavigationDirection(event: NavigationKeyInput, target: EventTarget | null): 'previous' | 'next' | null {
  return isEditableTarget(target) ? null : navigationDirection(event);
}
