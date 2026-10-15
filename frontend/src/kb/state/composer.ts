import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbQuote, KbRef } from '../../api/kb/types.gen';

/**
 * Hand-off into the message field from anywhere in the window: the selection toolbar ("Ask",
 * "Add to question"), "Ask agent about this" in a decision, ⌘Enter in search. The composer takes
 * every queued item (`take`) and turns it into tokens/text at the caret.
 */
export type ComposerItem =
  | { kind: 'quote'; quote: KbQuote }
  | { kind: 'mention'; ref: KbRef }
  | { kind: 'text'; text: string };

export interface ComposerBusState {
  queue: ComposerItem[];
  /** Send right after inserting (⌘Enter in search). */
  sendNow: boolean;
  /** Bumped when the composer should take focus. */
  focusTick: number;
  push: (items: ComposerItem[], options?: { focus?: boolean; send?: boolean }) => void;
  take: () => { items: ComposerItem[]; send: boolean };
}

export type ComposerBus = StoreApi<ComposerBusState>;

export function createComposerBus(): ComposerBus {
  return createStore<ComposerBusState>()((set, get) => ({
    queue: [],
    sendNow: false,
    focusTick: 0,
    push: (items, options = {}) => set((s) => ({
      queue: [...s.queue, ...items],
      sendNow: s.sendNow || options.send === true,
      focusTick: options.focus === false ? s.focusTick : s.focusTick + 1,
    })),
    take: () => {
      const { queue, sendNow } = get();
      set({ queue: [], sendNow: false });
      return { items: queue, send: sendNow };
    },
  }));
}
