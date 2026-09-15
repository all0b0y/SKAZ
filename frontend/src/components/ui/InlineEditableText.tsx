import { useState } from 'react';

interface InlineEditableTextProps {
  /** Current committed value. */
  value: string;
  /** Called with the trimmed new value once it differs and is non-empty. */
  onCommit: (value: string) => void;
  /** Class for the static (non-editing) display span. */
  className?: string;
  /** Class for the editing input. */
  inputClassName?: string;
  ariaLabel?: string;
}

/**
 * A label that turns into a text input on double-click.
 * Enter or blur commits, Escape cancels. Shared by the session rail and the
 * titlebar's active-session name so the rename gesture stays in one place.
 */
export function InlineEditableText({
  value,
  onCommit,
  className,
  inputClassName,
  ariaLabel,
}: InlineEditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        className={inputClassName}
        value={draft}
        autoFocus
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      className={className}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}
