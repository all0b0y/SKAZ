import { useEffect, type ReactNode } from 'react';
import { IconButton } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import './readerHeader.css';

export interface ReaderHeaderProps {
  typeLabel: string;
  typeIcon?: IconName;
  /** Rich type/status label used by the live reader. */
  typeStatus?: ReactNode;
  expanded: boolean;
  onClose: () => void;
  onBack?: () => void;
  onToggleExpanded?: () => void;
  closeLabel?: string;
  /** Inline actions supplied by the current material or page. */
  actions?: ReactNode;
  /** Menu trigger and its anchored menu, kept together so the host owns their focus. */
  more?: ReactNode;
}

/** The reader host owns the document, its history and the expanded state. */
export function ReaderHeader({
  typeLabel, typeIcon, typeStatus, expanded, onClose, onBack, onToggleExpanded, closeLabel = 'Close document', actions, more,
}: ReaderHeaderProps) {
  useEffect(() => {
    if (!onBack) return;
    const handleBack = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)
        || event.altKey || event.shiftKey || event.key !== '[') return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', handleBack);
    return () => window.removeEventListener('keydown', handleBack);
  }, [onBack]);

  return (
    <header className="kb-head kb-reader-header">
      {onBack && <IconButton icon="chevronLeft" label="Back" aria-keyshortcuts="Meta+BracketLeft" onClick={onBack} />}
      <span className="kb-reader-header__type">
        {typeIcon && <Icon name={typeIcon} size={14} />}
        <span className="kb-reader-header__label" title={typeStatus ? undefined : typeLabel}>{typeStatus ?? typeLabel}</span>
      </span>
      <div className="kb-reader-header__actions">
        {actions}
        {onToggleExpanded && (
          <IconButton
            className="kb-panel-expand"
            icon={expanded ? 'collapse' : 'expand'}
            label={expanded ? 'Back to side panel' : 'Expand to the centre'}
            aria-pressed={expanded}
            onClick={onToggleExpanded}
          />
        )}
        {more}
        <IconButton icon="close" label={closeLabel} onClick={onClose} />
      </div>
    </header>
  );
}
