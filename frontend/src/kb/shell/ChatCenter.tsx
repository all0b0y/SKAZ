import { AllChats } from '../chat/ChatList';
import { ChatView } from '../chat/ChatView';
import { useUi } from '../state/context';

/**
 * Centre column: the open chat, or "All chats" over the whole centre (v16). Hidden (not unmounted)
 * while an expanded document takes the centre, so the message field keeps its text.
 */
export function ChatCenter({ hidden }: { hidden: boolean }) {
  const view = useUi((s) => s.center);
  if (view === 'allChats' && !hidden) return <AllChats />;
  return <ChatView hidden={hidden} />;
}
