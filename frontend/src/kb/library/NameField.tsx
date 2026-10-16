import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../state/library';
import { TextField } from '../ui';

export interface NameFieldProps {
  label: string;
  initial?: string;
  placeholder?: string;
  onSubmit: (name: string) => Promise<ActionResult<unknown>>;
  onDone: () => void;
}

/**
 * Inline name entry for a folder (create / rename). Enter saves, Escape cancels. A refusal from
 * the backend (name taken, invalid) stays next to the field in the backend's words; the field
 * keeps the typed name so it can be corrected.
 */
export function NameField({ label, initial = '', placeholder, onSubmit, onDone }: NameFieldProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);

  const submit = async () => {
    const name = value.trim();
    if (!name) { setError('Enter a name.'); return; }
    if (name === initial.trim()) { onDone(); return; }
    setBusy(true);
    const result = await onSubmit(name);
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.error);
  };

  return (
    <form
      className="kb-namefield"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <TextField
        ref={ref}
        label={label}
        hideLabel
        value={value}
        placeholder={placeholder}
        error={error}
        disabled={busy}
        leading="folder"
        maxLength={120}
        onChange={(event) => { setValue(event.target.value); if (error) setError(null); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(); }
        }}
        onBlur={(event) => {
          // Leaving an untouched field cancels; a typed name waits for Enter or an explicit cancel.
          const next = event.relatedTarget as Node | null;
          if (!value.trim() && !(next && event.currentTarget.form?.contains(next))) onDone();
        }}
      />
    </form>
  );
}
