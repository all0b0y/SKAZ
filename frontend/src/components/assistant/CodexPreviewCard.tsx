import { useState } from 'react';
import { ApiError } from '../../api/client';
import type { CodexPreview } from '../../api/codex';
import type { Note, Session } from '../../api/types';
import { noteName } from '../../state/noteTabs';
import { RewriteDiff } from '../notes/RewriteDiff';

interface Props {
  preview: CodexPreview;
  sessions: Session[];
  /** Notes of the session on screen, to name the target note when it is known. */
  knownNotes: Note[];
  readOnly: boolean;
  onApply: (preview: CodexPreview) => Promise<Note>;
  onDiscard: (preview: CodexPreview) => Promise<void>;
  onApplied: (preview: CodexPreview, note: Note) => void;
}

/**
 * A change to an existing note that the agent prepared. Nothing is written until
 * the user compares both versions and presses "Применить"; a note edited since
 * the preview was made is refused by the backend and shown as a conflict — it is
 * never overwritten from here.
 */
export function CodexPreviewCard({ preview, sessions, knownNotes, readOnly, onApply, onDiscard, onApplied }: Props) {
  const [comparing, setComparing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const note = knownNotes.find((n) => n.id === preview.note_id);
  const session = sessions.find((s) => s.id === preview.session_id);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const saved = await onApply(preview);
      setComparing(false);
      onApplied(preview, saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setComparing(false);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setApplying(false);
    }
  };

  if (preview.status !== 'pending') return null;
  return (
    <li className="codex-preview" data-testid="codex-preview">
      <strong>Proposed note edit</strong>
      <small>
        {note ? `“${noteName(note)}”` : 'Existing note'} · {session?.title ?? 'another session'}
      </small>
      {conflict ? (
        <p className="codex-task__error" role="alert">
          The note changed after this edit was prepared. Re-read it and ask for a new edit — the old version will not be written over it.
        </p>
      ) : (
        error && !comparing && <p className="codex-task__error" role="alert">{error}</p>
      )}
      <div className="codex-preview__actions">
        <button type="button" className="btn btn--primary" disabled={readOnly || conflict}
          title={readOnly ? 'This chat’s access was revoked' : undefined} onClick={() => setComparing(true)}>
          Compare and apply
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => void onDiscard(preview).catch((err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)))}>
          Cancel
        </button>
      </div>
      {comparing && (
        <RewriteDiff
          title="Note edit"
          subtitle={`${note ? `“${noteName(note)}”` : 'Note'} · ${session?.title ?? 'another session'}. Written only after you confirm.`}
          original={preview.original}
          replacement={preview.replacement}
          applying={applying}
          error={error}
          onApply={() => void apply()}
          onCancel={() => setComparing(false)}
        />
      )}
    </li>
  );
}
