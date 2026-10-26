import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useStore } from 'zustand';
import { DiagramSelectProvider, type DiagramSelect } from '../../ui/markdown/Diagram';
import { attachSelection, type Attached } from './items';
import { markDiagram } from './mermaid';
import { diagramId, type Selection } from './model';
import { createSelectionStore, type SelectionState, type SelectionStore } from './store';

/**
 * P2: one selection per open chat (ChatView provides it; the composer and the answers share it).
 * Elsewhere (a wiki page, the viewer) there is no provider and nothing is selectable.
 */
const StoreContext = createContext<SelectionStore | null>(null);

export function SelectionProvider({ chatId, children }: { chatId: string | null; children: ReactNode }) {
  const [store] = useState(createSelectionStore);
  // Another chat: what was picked in the previous one is gone.
  useEffect(() => { store.getState().clear(); }, [store, chatId]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useSelectionStore(): SelectionStore | null {
  return useContext(StoreContext);
}

const NONE: SelectionState = { selection: null, toggle: () => {}, clear: () => {} };
const noStore = { getState: () => NONE, subscribe: () => () => {} } as unknown as SelectionStore;

/** The current selection (null without a provider). */
export function useSelection(): { selection: Selection | null; clear: () => void } {
  const store = useSelectionStore();
  const selection = useStore(store ?? noStore, (s) => s.selection);
  return { selection, clear: (store ?? noStore).getState().clear };
}

interface AnswerScope { messageId: string; store: SelectionStore }
const AnswerContext = createContext<AnswerScope | null>(null);
/** The answer a part is drawn in (the «Fix in wiki» card needs it for its route). */
const AnswerIdContext = createContext<string | null>(null);
export const useAnswerId = (): string | null => useContext(AnswerIdContext);

/**
 * Wraps one answer's parts: its blocks and diagrams become selectable, addressed by this message's
 * id. Diagrams are drawn by the shared Markdown renderer, so they get the hook through
 * `DiagramSelectProvider` (ui/markdown/Diagram.tsx) rather than knowing about chats.
 */
export function AnswerSelectScope({ messageId, children }: { messageId: string; children: ReactNode }) {
  const store = useSelectionStore();
  const scope = useMemo(() => (store ? { messageId, store } : null), [messageId, store]);
  const diagram = useMemo<DiagramSelect | null>(() => (scope ? (host, source) => {
    const svg = host.querySelector('svg');
    if (!svg || !markDiagram(svg, source)) return () => {};
    const blockId = diagramId(source);
    host.setAttribute('data-block-id', blockId); // like every block root: the chip finds it
    const { detach } = attachSelection(host, { message_id: scope.messageId, block_id: blockId, kind: 'diagram', title: null },
      scope.store);
    return () => { detach(); host.removeAttribute('data-block-id'); };
  } : null), [scope]);
  if (!scope) return <AnswerIdContext.Provider value={messageId}>{children}</AnswerIdContext.Provider>;
  return (
    <AnswerIdContext.Provider value={messageId}>
      <AnswerContext.Provider value={scope}>
        <DiagramSelectProvider value={diagram}>{children}</DiagramSelectProvider>
      </AnswerContext.Provider>
    </AnswerIdContext.Provider>
  );
}

/**
 * An answer block's items become selectable (generic: by `data-item-id` under the block's root).
 * Call from the block's root component with its element.
 */
export function useSelectableBlock(ref: RefObject<HTMLElement | null>, blockId: string, title: string | null | undefined): void {
  const scope = useContext(AnswerContext);
  const attached = useRef<Attached | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!scope || !root) return undefined;
    const handle = attachSelection(root, { message_id: scope.messageId, block_id: blockId, kind: 'block', title: title ?? null },
      scope.store);
    attached.current = handle;
    return () => { handle.detach(); attached.current = null; };
  }, [scope, ref, blockId, title]);
  // After every render: items a re-render added get their attributes too.
  useLayoutEffect(() => { attached.current?.sync(); });
}
