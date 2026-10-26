import { Icon, IconButton } from '../../ui';
import { itemsLabel, type Selection } from './model';

/** The quick asks of the selection bar that send a message (texts from answer-blocks-v3.html). */
export type QuickAsk = 'explain' | 'wrong';

export const QUICK_TEXT: Record<QuickAsk, string> = {
  explain: 'Explain more',
  wrong: 'That’s wrong',
};

/**
 * P2 decision 3: over the message field while something is picked — what is picked, the quick
 * asks («Explain more», «Where is this from?», «That’s wrong») and Clear selection (✕, or Esc).
 * The field below asks about the selection.
 */
export function SelectionBar({ selection, onClear, onQuick, onWhere, whereOpen = false, disabledReason = null }: {
  selection: Selection;
  onClear: () => void;
  onQuick?: (ask: QuickAsk) => void;
  /** «Where is this from?»: SKAZ shows the sources itself, no agent. */
  onWhere?: () => void;
  whereOpen?: boolean;
  /** Why the quick asks that send can't send now (the agent is answering…). */
  disabledReason?: string | null;
}) {
  const what = `${itemsLabel(selection.items)} selected`;
  const full = selection.items.map((i) => i.label).join('; ');
  return (
    <div className="kb-pickbar" role="group" aria-label="Selection">
      <span className="kb-pickbar__what" title={full}>
        <Icon name="pin" size={13} />
        <span role="status">{what}</span>
        {selection.title && <span className="kb-pickbar__where">· {selection.title}</span>}
      </span>
      {onQuick && (
        <button type="button" className="kb-qbtn" aria-disabled={!!disabledReason || undefined} title={disabledReason ?? undefined}
          onClick={() => { if (!disabledReason) onQuick('explain'); }}>
          <Icon name="help" size={13} />{QUICK_TEXT.explain}
        </button>
      )}
      {onWhere && (
        <button type="button" className="kb-qbtn" aria-expanded={whereOpen} onClick={onWhere}>
          <Icon name="quote" size={13} />Where is this from?
        </button>
      )}
      {onQuick && (
        <button type="button" className="kb-qbtn" aria-disabled={!!disabledReason || undefined} title={disabledReason ?? undefined}
          onClick={() => { if (!disabledReason) onQuick('wrong'); }}>
          <Icon name="warning" size={13} />{QUICK_TEXT.wrong}
        </button>
      )}
      <IconButton icon="close" size="sm" label="Clear selection" className="kb-pickbar__x" tooltipPlacement="top" onClick={onClear} />
    </div>
  );
}
