import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbQuote, KbRef } from '../../api/kb/types.gen';

/**
 * Hand-off into the message field from anywhere in the window: the selection toolbar ("Ask",
 * "Add to question"), "Ask agent about this" in a decision. The composer takes every queued item
 * (`take`) and turns it into tokens/text at the caret. Nothing handed over is ever sent by itself:
 * the user sees it in the field and sends it (⌘K asks in a new chat on its own, see CommandK).
 */
export type ComposerItem =
  | { kind: 'quote'; quote: KbQuote }
  | { kind: 'mention'; ref: KbRef }
  | { kind: 'text'; text: string };

export interface ComposerBusState {
  queue: ComposerItem[];
  /** Bumped when the composer should take focus. */
  focusTick: number;
  push: (items: ComposerItem[], options?: { focus?: boolean }) => void;
  take: () => ComposerItem[];
  /** Unsent drafts by chat (`new` = New chat): a draft is never lost or mixed into another question. */
  drafts: Map<string, ComposerDraft>;
}

/** What a chat's field held when the user left it: its nodes and attachments, given back on return. */
export interface ComposerDraft {
  nodes: Node[];
  attachments: readonly object[];
}

export type ComposerBus = StoreApi<ComposerBusState>;

export function createComposerBus(): ComposerBus {
  return createStore<ComposerBusState>()((set, get) => ({
    queue: [],
    focusTick: 0,
    drafts: new Map(),
    push: (items, options = {}) => set((s) => ({
      queue: [...s.queue, ...items],
      focusTick: options.focus === false ? s.focusTick : s.focusTick + 1,
    })),
    take: () => {
      const { queue } = get();
      set({ queue: [] });
      return queue;
    },
  }));
}
