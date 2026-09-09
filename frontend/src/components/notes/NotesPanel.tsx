import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { formatRange } from '../../lib/time';

export function NotesPanel() {
  const detail = useStore((s) => s.detail);
  const generating = useStore((s) => s.notesGenerating);
  const error = useStore((s) => s.notesError);
  const recorderState = useStore((s) => s.recorderState);
  const generate = useStore((s) => s.generateNotes);
  const activeId = useStore((s) => s.activeSessionId);

  const notes = detail?.notes ?? null;
  const capturing = recorderState === 'recording' || recorderState === 'paused';
  const hasSegments = (detail?.segments.length ?? 0) > 0;

  return (
    <div className="notes">
      <header className="notes__head">
        <div>
          <h3 className="notes__title">Notes</h3>
          {notes && (
            <p className="notes__meta tabular">
              Generated {new Date(notes.created_at).toLocaleString()} · {notes.model}
            </p>
          )}
        </div>
        <Button
          variant="primary"
          icon="notes"
          onClick={() => void generate()}
          disabled={!activeId || generating || capturing || !hasSegments}
          title={capturing ? 'Stop recording to generate notes' : undefined}
        >
          {generating ? 'Generating…' : notes ? 'Regenerate' : 'Generate notes'}
        </Button>
      </header>

      {error && (
        <p className="notes__error" role="alert">
          {error}
        </p>
      )}

      <div className="notes__body">
        {generating && !notes && <p className="loading">Reviewing the transcript and drafting notes…</p>}
        {!generating && !notes && (
          <EmptyState
            icon="notes"
            title="No notes yet"
            hint={
              capturing
                ? 'Notes are drafted from the transcript after you stop recording.'
                : hasSegments
                  ? 'Generate a summary of the key points, definitions, and decisions.'
                  : 'Record and transcribe first — notes are built from the transcript.'
            }
          />
        )}
        {notes && (
          <article className="notes__content">
            {notes.content.split('\n').map((line, i) =>
              line.trim() === '' ? <br key={i} /> : <p key={i}>{line}</p>,
            )}
            {notes.citations.length > 0 && (
              <footer className="notes__sources">
                <h4>Sources</h4>
                <ul>
                  {notes.citations.map((c, i) => (
                    <li key={`${c.segment_id}-${i}`} className="tabular">
                      {formatRange(c.start_ms, c.end_ms)} — <span>{c.text}</span>
                    </li>
                  ))}
                </ul>
              </footer>
            )}
          </article>
        )}
      </div>
    </div>
  );
}
