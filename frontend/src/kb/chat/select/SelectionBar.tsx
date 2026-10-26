import { Icon, IconButton } from '../../ui';
import { itemsLabel, type Selection } from './model';

/** The quick asks of the selection bar (texts from answer-blocks-v3.html). */
export type QuickAsk = 'explain' | 'where' | 'wrong';

export const QUICK_TEXT: Record<Exclude<QuickAsk, 'where'>, string> = {
  explain: 'Explain more',
  wrong: 'That’s wrong',
};

/**
 * P2 decision 3: over the message field while something is picked — what is picked, the quick
 * asks («Explain more», «Where is this from?», «That’s wrong») and Clear selection (✕, or Esc).
 * The field below asks about the selection.
 */
export function SelectionBar({ selection, onClear, onQuick, whereOpen = false, disabledReason = null }: {
  selection: Selection;
  onClear: () => void;
  onQuick?: (ask: QuickAsk) => void;
  whereOpen?: boolean;
  /** Why the quick asks that send can't send now (the agent is answering…). */
  disabledReason?: string | null;
}) {
  const what = `${itemsLabel(selection.items)} selected`;
  const full = selection.items.map((i) => i.label).join('; ');
  return (
    <div className="kb-selbar" role="group" aria-label="Selection">
      <span className="kb-selbar__what" title={full}>
        <Icon name="pin" size={13} />
        <span role="status">{what}</span>
        {selection.title && <span className="kb-selbar__where">· {selection.title}</span>}
      </span>
      {onQuick && (
        <>
          <button type="button" className="kb-qbtn" aria-disabled={!!disabledReason || undefined} title={disabledReason ?? undefined}
            onClick={() => { if (!disabledReason) onQuick('explain'); }}>
            <Icon name="help" size={13} />{QUICK_TEXT.explain}
          </button>
          <button type="button" className="kb-qbtn" aria-expanded={whereOpen} onClick={() => onQuick('where')}>
            <Icon name="quote" size={13} />Where is this from?
          </button>
          <button type="button" className="kb-qbtn" aria-disabled={!!disabledReason || undefined} title={disabledReason ?? undefined}
            onClick={() => { if (!disabledReason) onQuick('wrong'); }}>
            <Icon name="warning" size={13} />{QUICK_TEXT.wrong}
          </button>
        </>
      )}
      <IconButton icon="close" size="sm" label="Clear selection" className="kb-selbar__x" tooltipPlacement="top" onClick={onClear} />
    </div>
  );
}
