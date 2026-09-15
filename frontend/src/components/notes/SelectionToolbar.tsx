import { forwardRef } from 'react';
import { formatTimecode } from '../../lib/time';
import type { Citation } from '../../api/types';

export interface SelectionToolbarPosition {
  top: number;
  left: number;
}

interface SelectionToolbarProps {
  position: SelectionToolbarPosition;
  /** Only present when citationMatch found a confident source for the
   * current selection — no citation means no jump-to-transcript button. */
  matchedCitation: Citation | null;
  copyLabel: string;
  onOpenInTranscript: () => void;
  onCopy: () => void;
  onAsk: () => void;
}

/** Compact floating toolbar shown next to a notes text selection: jump to
 * the source (only when found), copy the selection, or ask about it. */
export const SelectionToolbar = forwardRef<HTMLDivElement, SelectionToolbarProps>(
  function SelectionToolbar(
    { position, matchedCitation, copyLabel, onOpenInTranscript, onCopy, onAsk },
    ref,
  ) {
    return (
      <div
        ref={ref}
        className="notes__selection-toolbar"
        role="toolbar"
        aria-label="Selection actions"
        style={{ top: position.top, left: position.left }}
      >
        {matchedCitation && (
          <button type="button" onClick={onOpenInTranscript}>
            Open in transcript {formatTimecode(matchedCitation.start_ms)}
          </button>
        )}
        <button type="button" onClick={onCopy}>{copyLabel}</button>
        <button type="button" onClick={onAsk}>Ask</button>
      </div>
    );
  },
);
