import { useUi } from '../state/context';
import { IconButton } from '../ui';

/** N8: the chat header's button — the chat overview beside the chat (again: closes it). */
export function ChatOverviewButton({ chatId }: { chatId: string }) {
  const right = useUi((s) => s.right);
  const openOverview = useUi((s) => s.openOverview);
  const closeDoc = useUi((s) => s.closeDoc);
  const open = right?.kind === 'overview' && right.chatId === chatId;
  return (
    <IconButton icon="panelRight" label={open ? 'Close the chat overview' : 'Chat overview'} aria-pressed={open} active={open}
      onClick={() => (open ? closeDoc() : openOverview(chatId))} />
  );
}
