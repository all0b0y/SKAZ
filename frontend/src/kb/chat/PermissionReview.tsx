import { EmptyState, Icon } from '../ui';
import { useChats } from '../state/context';
import { useOpenDocument } from '../state/document';
import { PanelFrameButtons } from '../document/parts';
import { partsOf, type KbPermissionPart } from '../api/permissions';
import { ChangeList, DecisionBar, KindNote, PermissionOutcome, agentName, summaryPills } from './permission';

const VERB: Record<KbPermissionPart['kind'], string> = { create: 'create', edit: 'edit', rename: 'rename', delete: 'delete' };

/** The request as the chat has it now (live: a decision in the card shows here at once). */
function usePermissionPart(chatId: string, partId: string): KbPermissionPart | null {
  return useChats((s) => {
    const chat = s.chats[chatId]?.chat;
    for (const m of chat?.messages ?? []) {
      const part = partsOf(m).find((p) => p.type === 'permission' && p.id === partId);
      if (part) return part as KbPermissionPart;
    }
    return null;
  });
}

/**
 * An agent's permission request beside the chat (P4: the book icon of the card): every change on
 * the page's own look — added / changed / removed written and marked — and the same decision bar,
 * pinned at the bottom. The chat stays usable while you read.
 */
export function PermissionReview({ chatId, partId }: { chatId: string; partId: string }) {
  const part = usePermissionPart(chatId, partId);
  const open = useOpenDocument();
  const n = part?.changes.length ?? 0;
  return (
    <div className="kb-review">
      <header className="kb-head kb-head--doc">
        <span className="kb-doc__type"><Icon name="permission" size={14} /><span>Review{part ? ` · ${part.title}` : ''}</span></span>
        <span className="kb-head__spacer" />
        <PanelFrameButtons closeLabel="Close review" />
      </header>
      {!part ? (
        <div className="kb-review__body">
          <EmptyState icon="wiki" title="This request isn’t here any more" compact>Open its chat to see what was decided.</EmptyState>
        </div>
      ) : (
        <>
          <div className="kb-review__legend" aria-hidden="true">
            <span><i style={{ background: 'var(--kb-ok)' }} />added</span>
            <span><i style={{ background: 'var(--kb-warn)' }} />changed</span>
            <span><i style={{ background: 'var(--kb-danger)' }} />removed</span>
          </div>
          <div className="kb-review__body">
            <h2 className="kb-review__title">{part.title}</h2>
            <p className="kb-review__meta">{agentName(part.engine)} wants to {VERB[part.kind]} · {n} {n === 1 ? 'change' : 'changes'}</p>
            <p className="kb-visually-hidden">{summaryPills(part).map((p) => p.text).join(', ')}</p>
            <ChangeList part={part} />
            <KindNote part={part} />
          </div>
          <div className="kb-review__bottom">
            {part.status === 'pending'
              ? <DecisionBar chatId={chatId} part={part} />
              : <PermissionOutcome chatId={chatId} part={part} onOpen={(id) => open({ type: 'page', id })} />}
          </div>
        </>
      )}
    </div>
  );
}
