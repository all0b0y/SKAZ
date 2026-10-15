import { AllChats } from '../chat/ChatList';
import { ChatView } from '../chat/ChatView';
import { useUi } from '../state/context';

/**
 * Centre column: the open chat, or "All chats" over the whole centre (v16). The chat is hidden,
 * not unmounted, while a list or an expanded document takes the centre, so the message field
 * keeps its text.
 */
export function ChatCenter({ hidden }: { hidden: boolean }) {
  const view = useUi((s) => s.center);
  return (
    <>
      {view === 'allChats' && !hidden && <AllChats />}
      <ChatView hidden={hidden || view === 'allChats'} />
    </>
  );
}
