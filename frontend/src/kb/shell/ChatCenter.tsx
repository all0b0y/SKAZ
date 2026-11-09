import { useEffect, useRef } from 'react';
import { AllChats } from '../chat/ChatList';
import { ChatView } from '../chat/ChatView';
import { getResearchStore, ResearchCenterView, useResearch } from '../research';
import { useChats, useServices, useUi } from '../state/context';

/**
 * Centre column: the open chat, a research task (F2), or "All chats" over the whole centre (v16).
 * The chat is hidden, not unmounted, while a list or an expanded document takes the centre, so the
 * message field keeps its text.
 */
export function ChatCenter({ hidden }: { hidden: boolean }) {
  const { client } = useServices();
  const view = useUi((s) => s.center);
  // Opening any chat (list, link, search, notification) leaves the research task view.
  const currentId = useChats((s) => s.currentId);
  const lastId = useRef(currentId);
  useEffect(() => {
    if (lastId.current !== currentId) getResearchStore(client).getState().close();
    lastId.current = currentId;
  }, [client, currentId]);
  const researchMode = useResearch((s) => s.mode);
  const showResearch = !hidden && view !== 'allChats' && researchMode !== 'closed';
  return (
    <>
      {view === 'allChats' && !hidden && <AllChats />}
      {showResearch && (
        <section className="kb-center" data-pane="center" aria-label="Research task">
          <ResearchCenterView />
        </section>
      )}
      <ChatView hidden={hidden || view === 'allChats' || showResearch} />
    </>
  );
}
