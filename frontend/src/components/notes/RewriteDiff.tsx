import { createPortal } from 'react-dom';
import { useEffect, useRef } from 'react';

interface Props {
  original: string;
  replacement: string;
  /** Set while the accepted replacement is being written. */
  applying?: boolean;
  error?: string | null;
  /** Heading and explanation; default to the passage-rewrite wording. */
  title?: string;
  subtitle?: string;
  onApply: () => void;
  onCancel: () => void;
}

/**
 * The old passage beside the written one, before anything is stored.
 *
 * Side by side rather than inline: the two are read against each other, and a
 * stacked diff makes that a scroll instead of a glance. It is a window-wide modal
 * because the notes pane is one column of a three-column window — two columns of
 * prose inside it would be too narrow to read, which is the whole point.
 *
 * Nothing here is applied automatically. A rewrite the user does not accept must
 * leave the note exactly as it was.
 */
export function RewriteDiff({ original, replacement, applying, error, title, subtitle, onApply, onCancel }: Props) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !applying) onCancel();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [applying, onCancel]);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  // Modal = application level (PANES-SPEC §1): rendered at <body> so no
  // column's clipping or containment can capture it.
  return createPortal(
    <div className="rewrite-overlay" role="presentation">
      <div
        ref={dialog}
        className="rewrite"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Passage comparison'}
        tabIndex={-1}
      >
        <header className="rewrite__head">
          <h2>{title ?? 'Regenerate passage'}</h2>
          <p>{subtitle ?? 'Only the selected passage is replaced. The rest of the text stays the same.'}</p>
        </header>

        <div className="rewrite__panes">
          <section className="rewrite__pane" aria-label="Current passage">
            <h3>Current</h3>
            <pre className="rewrite__text">{original}</pre>
          </section>
          <section className="rewrite__pane rewrite__pane--new" aria-label="New passage">
            <h3>New version</h3>
            <pre className="rewrite__text">{replacement}</pre>
          </section>
        </div>

        {error && <p className="rewrite__error" role="alert">{error}</p>}

        <footer className="rewrite__actions">
          <button type="button" className="btn btn--ghost" disabled={applying} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={applying} onClick={onApply}>
            {applying ? 'Applying…' : 'Apply'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
