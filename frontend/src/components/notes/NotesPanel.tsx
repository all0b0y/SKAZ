import { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { InlineEditableText } from '../ui/InlineEditableText';
import { stripTags } from '../../lib/sessionTags';
import { formatRange } from '../../lib/time';
import { findCitationForSelection } from '../../lib/citationMatch';
import { highlightCitedText } from '../../lib/citationHighlight';
import { copyToClipboard } from '../../lib/clipboard';
import { SelectionToolbar } from './SelectionToolbar';
import type { Citation } from '../../api/types';

interface NotesPanelProps {
  onCite: (citation: Citation) => void;
}

// Notes content is generated from an untrusted audio transcript (see
// AGENTS.md: transcript text is data, never instructions). react-markdown
// escapes/ignores raw HTML by default — rehype-raw is never wired in here,
// so embedded <script>/<img onerror> etc. can never execute, only ever show
// as inert text or disappear entirely.
const isSafeExternalUrl = (href?: string): boolean => (
  typeof href === 'string' && /^https?:\/\//i.test(href.trim())
);

const markdownComponents: Components = {
  // Only genuine http(s) links become clickable, and always open outside the
  // app window (target=_blank + rel=noopener noreferrer) rather than
  // navigating this Electron renderer away from itself. Anything else
  // (javascript:, data:, relative paths that don't resolve to anything real)
  // renders as plain inert text instead of a clickable link.
  a: ({ href, children }) => (
    isSafeExternalUrl(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <>{children}</>
  ),
};

const COPY_FEEDBACK_MS = 1_500;

interface SelectionState {
  text: string;
  top: number;
  left: number;
}

export function NotesPanel({ onCite }: NotesPanelProps) {
  const detail = useStore((s) => s.detail);
  const generating = useStore((s) => s.notesGenerating);
  const error = useStore((s) => s.notesError);
  const recorderState = useStore((s) => s.recorderState);
  const generate = useStore((s) => s.generateNotes);
  const setAskContext = useStore((s) => s.setAskContext);
  const renameSession = useStore((s) => s.renameSession);
  const activeId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  const notes = detail?.notes ?? null;
  const capturing = recorderState === 'recording' || recorderState === 'paused';
  const hasSegments = (detail?.segments.length ?? 0) > 0;

  const contentRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [copied, setCopied] = useState(false);

  // Selection is cleared whenever the notes content itself changes (e.g.
  // regenerated), so a stale toolbar never points at text that is gone.
  useEffect(() => {
    setSelection(null);
  }, [notes?.content]);

  useEffect(() => {
    const handleSelectionCandidate = (event: Event) => {
      // Ignore interactions with our own toolbar buttons — clicking "Copy"
      // must not be mistaken for "the user selected something else".
      if (toolbarRef.current?.contains(event.target as Node)) return;
      const container = contentRef.current;
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!container || !sel || sel.rangeCount === 0 || !text) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const rangeRect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setSelection({
        text,
        top: rangeRect.top - containerRect.top + container.scrollTop,
        left: rangeRect.left - containerRect.left,
      });
      setCopied(false);
    };
    document.addEventListener('mouseup', handleSelectionCandidate);
    document.addEventListener('keyup', handleSelectionCandidate);
    return () => {
      document.removeEventListener('mouseup', handleSelectionCandidate);
      document.removeEventListener('keyup', handleSelectionCandidate);
    };
  }, []);

  const matchedCitation = selection && notes
    ? findCitationForSelection(selection.text, notes.citations)
    : null;

  const handleOpenInTranscript = () => {
    if (!matchedCitation) return;
    onCite(matchedCitation);
    setSelection(null);
  };

  const handleCopy = () => {
    if (!selection) return;
    void copyToClipboard(selection.text).then((ok) => {
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
      }
    });
  };

  const handleAsk = () => {
    if (!selection) return;
    // Do NOT ask anything yet. The fragment goes to the chat composer as
    // context; the user writes their own question about it and sends when
    // ready. The timecode rides along only when citationMatch actually
    // resolved the fragment — never a guessed one.
    setAskContext({ text: selection.text, citation: matchedCitation });
    setSelection(null);
  };

  return (
    <div className="notes">
      <header className="notes__head">
        <div>
          {/* The notes heading is the session's own name: Notes has no title
              field in the API and there is exactly one note per session, so a
              second independent name would be a fiction to maintain. Editing
              here renames the session everywhere (rail, titlebar). */}
          {activeSession ? (
            <InlineEditableText
              value={stripTags(activeSession.title)}
              onCommit={(title) => void renameSession(activeSession.id, title)}
              className="notes__title"
              inputClassName="notes__title-input"
              ariaLabel={`Rename ${activeSession.title}`}
            />
          ) : (
            <h3 className="notes__title">Notes</h3>
          )}
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
          <div className="notes__content-wrap">
            <article className="notes__content" ref={contentRef}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[highlightCitedText, notes.citations]]}
                components={markdownComponents}
              >
                {notes.content}
              </ReactMarkdown>
            </article>
            {selection && (
              <SelectionToolbar
                ref={toolbarRef}
                position={{ top: selection.top, left: selection.left }}
                matchedCitation={matchedCitation}
                copyLabel={copied ? 'Copied' : 'Copy'}
                onOpenInTranscript={handleOpenInTranscript}
                onCopy={handleCopy}
                onAsk={handleAsk}
              />
            )}
            {notes.citations.length > 0 && (
              <details className="notes__sources">
                <summary>Sources ({notes.citations.length})</summary>
                <ul>
                  {notes.citations.map((c, i) => (
                    <li key={`${c.segment_id}-${i}`} className="tabular">
                      {formatRange(c.start_ms, c.end_ms)} — <span>{c.text}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
