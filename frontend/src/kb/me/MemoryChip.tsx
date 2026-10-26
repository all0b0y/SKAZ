import { useState } from 'react';
import { Button, Icon } from '../ui';
import { useServices } from '../state/context';
import { errorText } from '../api/client';
import { memoryChipText, undoMeEdit } from './api';
import type { KbMemoryPart } from '../../api/kb/types.gen';

/**
 * An agent's edit of «Я» in its answer (N6 decision 7): one compact line «Remembered: …» or
 * «Updated skill "…"» with Undo. Undone (here or by the backend's `undone`), it reads "Undone".
 */
export function MemoryChip({ part }: { part: KbMemoryPart }) {
  const { client } = useServices();
  const [undoneHere, setUndoneHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undone = part.undone || undoneHere;
  const line = memoryChipText(part);

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await undoMeEdit(client, part.edit_id);
      setUndoneHere(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kb-memory" data-undone={undone || undefined} role="group" aria-label={undone ? `Undone: ${line}` : line}>
      <div className="kb-memory__row">
        <Icon name="me" size={14} className="kb-memory__icon" />
        <span className="kb-memory__line" title={part.summary || line}>{line}</span>
        {undone ? (
          <span className="kb-memory__undone"><Icon name="undo" size={13} />Undone</span>
        ) : (
          <Button size="sm" variant="quiet" icon="undo" busy={busy} onClick={() => void undo()}>Undo</Button>
        )}
      </div>
      {error && <p className="kb-inline-error kb-memory__error" role="alert">{error}</p>}
    </div>
  );
}
