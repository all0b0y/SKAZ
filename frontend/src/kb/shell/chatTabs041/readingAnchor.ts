/**
 * Per-chat reading anchor capture and restoration, scoped strictly to a chat's scroll container
 * and guarded by a scope token so stale async/deferred restores never overwrite a later switch.
 */

export const DEFAULT_MESSAGE_SELECTOR = '[data-message-id]';
export const DEFAULT_MESSAGE_ID_ATTR = 'data-message-id';
export const DEFAULT_BOTTOM_THRESHOLD = 40;
export const DEFAULT_READING_LINE_PX = 16;

export interface ReadingAnchor {
  /** Message ID visible at the reading line inside the scroll container, if any. */
  messageId: string | null;
  /** Offset of the anchored message's top edge relative to the container's viewport top (px). */
  offsetPx: number;
  /** Fallback scrollTop (px) used when the anchored message is unavailable. */
  scrollTop: number;
  /** True when the user was pinned near the bottom of the conversation. */
  stickToBottom: boolean;
  /** Monotonic/epoch timestamp when captured. */
  updatedAt: number;
}

export interface AnchorCaptureOptions {
  messageSelector?: string;
  messageIdAttr?: string;
  bottomThreshold?: number;
  /** The host can suspend bottom following during explicit reply navigation. */
  shouldFollow?: (container: HTMLElement) => boolean;
  readingLinePx?: number;
  now?: () => number;
}

export interface AnchorRestoreOptions {
  messageSelector?: string;
  messageIdAttr?: string;
  /** When no anchor is stored yet: jump to bottom instead of top (matches ChatView initial open). */
  defaultBottom?: boolean;
}

export interface AnchorRestoreResult {
  restored: boolean;
  mode: 'bottom' | 'anchor' | 'position' | 'top';
  scrollTop: number;
  stickToBottom: boolean;
  messageId: string | null;
}

export function maxScrollTop(container: Pick<HTMLElement, 'scrollHeight' | 'clientHeight'>): number {
  return Math.max(0, container.scrollHeight - container.clientHeight);
}

export function clampScrollTop(container: Pick<HTMLElement, 'scrollHeight' | 'clientHeight'>, scrollTop: number): number {
  if (!Number.isFinite(scrollTop)) return 0;
  return Math.max(0, Math.min(maxScrollTop(container), scrollTop));
}

export function isAtBottom(
  container: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  threshold = DEFAULT_BOTTOM_THRESHOLD,
): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

interface ElementBox {
  relTop: number;
  relBottom: number;
}

function measureInContainer(container: HTMLElement, el: HTMLElement): ElementBox {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const hasLayout =
    cRect.width > 0 || cRect.height > 0 || eRect.width > 0 || eRect.height > 0 || eRect.top !== 0 || cRect.top !== 0;
  if (hasLayout) {
    const relTop = eRect.top - cRect.top;
    const relBottom = eRect.bottom - cRect.top;
    return { relTop, relBottom };
  }
  const relTop = el.offsetTop - container.scrollTop;
  return { relTop, relBottom: relTop + (el.offsetHeight || 0) };
}

function findScopedMessage(
  container: HTMLElement,
  messageId: string,
  selector: string,
  attr: string,
): HTMLElement | null {
  const nodes = container.querySelectorAll<HTMLElement>(selector);
  for (const el of nodes) {
    if (el.getAttribute(attr) === messageId) return el;
  }
  return null;
}

/**
 * Capture the user's current reading position inside `container` (never querying `document`).
 */
export function captureReadingAnchor(
  container: HTMLElement | null | undefined,
  options: AnchorCaptureOptions = {},
): ReadingAnchor | null {
  if (!container) return null;
  const selector = options.messageSelector ?? DEFAULT_MESSAGE_SELECTOR;
  const attr = options.messageIdAttr ?? DEFAULT_MESSAGE_ID_ATTR;
  const bottomThreshold = options.bottomThreshold ?? DEFAULT_BOTTOM_THRESHOLD;
  const readingLinePx = options.readingLinePx ?? DEFAULT_READING_LINE_PX;
  const now = options.now ?? (() => Date.now());

  const scrollTop = Math.max(0, container.scrollTop);
  const stick = options.shouldFollow?.(container) ?? isAtBottom(container, bottomThreshold);
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(selector));

  let chosen: HTMLElement | null = null;
  let chosenBox: ElementBox | null = null;

  if (candidates.length > 0) {
    for (const el of candidates) {
      const box = measureInContainer(container, el);
      if (box.relBottom > readingLinePx) {
        chosen = el;
        chosenBox = box;
        break;
      }
      if (box.relTop <= readingLinePx) {
        chosen = el;
        chosenBox = box;
      }
    }
    if (!chosen) {
      chosen = candidates[0] ?? null;
      chosenBox = chosen ? measureInContainer(container, chosen) : null;
    }
  }

  const rawId = chosen?.getAttribute(attr) ?? null;
  const messageId = rawId && rawId.length > 0 ? rawId : null;

  return {
    messageId,
    offsetPx: chosenBox ? chosenBox.relTop : 0,
    scrollTop,
    stickToBottom: stick,
    updatedAt: now(),
  };
}

/**
 * Restore a previously captured reading anchor inside `container` (scoped only to `container`).
 * Priority: stickToBottom -> message anchor (+ offset) -> clamped scrollTop position fallback.
 */
export function restoreReadingAnchor(
  container: HTMLElement | null | undefined,
  anchor: ReadingAnchor | null | undefined,
  options: AnchorRestoreOptions = {},
): AnchorRestoreResult {
  if (!container) {
    return { restored: false, mode: 'top', scrollTop: 0, stickToBottom: false, messageId: null };
  }

  if (!anchor) {
    if (options.defaultBottom) {
      const target = maxScrollTop(container);
      container.scrollTop = target;
      return { restored: false, mode: 'bottom', scrollTop: target, stickToBottom: true, messageId: null };
    }
    container.scrollTop = 0;
    return { restored: false, mode: 'top', scrollTop: 0, stickToBottom: false, messageId: null };
  }

  if (anchor.stickToBottom) {
    const target = maxScrollTop(container);
    container.scrollTop = target;
    return { restored: true, mode: 'bottom', scrollTop: target, stickToBottom: true, messageId: anchor.messageId };
  }

  const selector = options.messageSelector ?? DEFAULT_MESSAGE_SELECTOR;
  const attr = options.messageIdAttr ?? DEFAULT_MESSAGE_ID_ATTR;

  if (anchor.messageId) {
    const el = findScopedMessage(container, anchor.messageId, selector, attr);
    if (el) {
      const eRect = el.getBoundingClientRect();
      const hasElementBox = eRect.width > 0 || eRect.height > 0 || el.offsetHeight > 0;
      if (hasElementBox) {
        const { relTop } = measureInContainer(container, el);
        const target = clampScrollTop(container, container.scrollTop + (relTop - anchor.offsetPx));
        container.scrollTop = target;
        return { restored: true, mode: 'anchor', scrollTop: target, stickToBottom: false, messageId: anchor.messageId };
      }
    }
  }

  const target = clampScrollTop(container, anchor.scrollTop);
  container.scrollTop = target;
  return { restored: true, mode: 'position', scrollTop: target, stickToBottom: false, messageId: null };
}

export interface AnchorScope {
  claim: (chatId: string | null) => number;
  isCurrent: (chatId: string | null, token: number) => boolean;
  clear: () => void;
  captureIfCurrent: (
    chatId: string | null,
    token: number,
    container: HTMLElement | null | undefined,
    options?: AnchorCaptureOptions,
  ) => ReadingAnchor | null;
  restoreIfCurrent: (
    chatId: string | null,
    token: number,
    container: HTMLElement | null | undefined,
    anchor: ReadingAnchor | null | undefined,
    options?: AnchorRestoreOptions,
  ) => AnchorRestoreResult | null;
}

/**
 * Scope guard for async/deferred anchor capture and restoration: a pending or stale operation
 * for an earlier tab never overwrites a later switch or close.
 */
export function createAnchorScope(): AnchorScope {
  let seq = 0;
  let currentChatId: string | null = null;

  const isCurrent = (chatId: string | null, token: number): boolean =>
    token === seq && chatId === currentChatId && chatId !== null;

  return {
    claim(chatId) {
      seq += 1;
      currentChatId = chatId;
      return seq;
    },
    isCurrent,
    clear() {
      seq += 1;
      currentChatId = null;
    },
    captureIfCurrent(chatId, token, container, options) {
      if (!isCurrent(chatId, token)) return null;
      return captureReadingAnchor(container, options);
    },
    restoreIfCurrent(chatId, token, container, anchor, options) {
      if (!isCurrent(chatId, token)) return null;
      return restoreReadingAnchor(container, anchor, options);
    },
  };
}
