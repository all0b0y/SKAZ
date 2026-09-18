import { useEffect, useRef } from 'react';

interface Props {
  original: string;
  replacement: string;
  /** Set while the accepted replacement is being written. */
  applying?: boolean;
  error?: string | null;
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
export function RewriteDiff({ original, replacement, applying, error, onApply, onCancel }: Props) {
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

  return (
    <div className="rewrite-overlay" role="presentation">
      <div
        ref={dialog}
        className="rewrite"
        role="dialog"
        aria-modal="true"
        aria-label="Сравнение фрагмента"
        tabIndex={-1}
      >
        <header className="rewrite__head">
          <h2>Перегенерация фрагмента</h2>
          <p>Заменится только выделенный фрагмент. Остальной текст не изменится.</p>
        </header>

        <div className="rewrite__panes">
          <section className="rewrite__pane" aria-label="Текущий фрагмент">
            <h3>Сейчас</h3>
            <pre className="rewrite__text">{original}</pre>
          </section>
          <section className="rewrite__pane rewrite__pane--new" aria-label="Новый фрагмент">
            <h3>Новый вариант</h3>
            <pre className="rewrite__text">{replacement}</pre>
          </section>
        </div>

        {error && <p className="rewrite__error" role="alert">{error}</p>}

        <footer className="rewrite__actions">
          <button type="button" className="btn btn--ghost" disabled={applying} onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="btn btn--primary" disabled={applying} onClick={onApply}>
            {applying ? 'Применяю…' : 'Применить'}
          </button>
        </footer>
      </div>
    </div>
  );
}
