import { useEffect, useRef, useState } from 'react';
import { sanitiseTitle } from '../../state/noteTabs';

interface Props {
  value: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}

/**
 * The inline field a double click opens over a note's name.
 *
 * A name that sanitises to nothing is not submitted at all: the field simply
 * closes and the previous name stays. That is the whole point of the rule — a
 * user who clears the field gets their old name back, never an unnamed note.
 */
export function NoteTitleInput({ value, onCommit, onCancel }: Props) {
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const commit = () => {
    const cleaned = sanitiseTitle(draft);
    if (!cleaned || cleaned === value) {
      onCancel();
      return;
    }
    onCommit(cleaned);
  };

  return (
    <input
      ref={field}
      className="note-title-input"
      aria-label="Название конспекта"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
