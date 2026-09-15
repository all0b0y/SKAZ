import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { WINDOW_PRESETS, formatTimecode } from '../../lib/time';
import type { ChatScope, Citation } from '../../api/types';
import figureUrl from '../../assets/images/chat-elements-girl.png';

const SCOPES: { value: ChatScope; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Pick the window from the question' },
  { value: 'recent', label: 'Recent', hint: 'The last few minutes' },
  { value: 'beginning', label: 'Start', hint: 'The beginning of the recording' },
  { value: 'search', label: 'Search', hint: 'Find a topic across the recording' },
  { value: 'all', label: 'All', hint: 'The whole session' },
];

interface AssistantPanelProps {
  onCite: (citation: Citation) => void;
}

export function AssistantPanel({ onCite }: AssistantPanelProps) {
  const detail = useStore((s) => s.detail);
  const asking = useStore((s) => s.asking);
  const askError = useStore((s) => s.askError);
  const scope = useStore((s) => s.chatScope);
  const windowMinutes = useStore((s) => s.windowMinutes);
  const activeId = useStore((s) => s.activeSessionId);
  const setScope = useStore((s) => s.setChatScope);
  const setWindow = useStore((s) => s.setWindowMinutes);
  const ask = useStore((s) => s.ask);
  const askContext = useStore((s) => s.askContext);
  const setAskContext = useStore((s) => s.setAskContext);
  const [question, setQuestion] = useState('');
  const [scopeOpen, setScopeOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A fragment quoted out of the notes focuses the composer so the user can
  // type their question about it straight away.
  useEffect(() => {
    if (askContext) inputRef.current?.focus();
  }, [askContext]);

  const messages = detail?.messages ?? [];
  const isEmpty = messages.length === 0 && !asking;

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, asking]);

  // Close the scope popover on Escape or on any click outside it. The scope
  // itself resets to 'auto' when the active session changes (state.selectSession) —
  // a sticky non-auto scope from a session visited an hour ago would silently
  // answer from the wrong window here.
  useEffect(() => {
    if (!scopeOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(event.target as Node)) {
        setScopeOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setScopeOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [scopeOpen]);

  const submit = () => {
    if (!question.trim() || asking) return;
    // A quoted notes fragment rides along as clearly-labelled context, not as
    // an instruction: transcript text is untrusted data (AGENTS.md). The
    // timecode is included only when citationMatch actually resolved the
    // fragment to a segment — never a guessed one.
    const payload = askContext
      ? `[Notes fragment${askContext.citation ? `, ${formatTimecode(askContext.citation.start_ms)}` : ''}]\n${askContext.text}\n\n${question}`
      : question;
    void ask(payload);
    setQuestion('');
    setAskContext(null);
  };

  const windowRelevant = scope === 'auto' || scope === 'recent';
  const activeScope = SCOPES.find((s) => s.value === scope);
  // Only 'recent' pins a fixed window; 'auto' derives it from the question, so
  // showing a window figure next to it would imply a precision that isn't there.
  const scopeLabel = scope === 'recent'
    ? `${activeScope?.label ?? 'Recent'} · ${windowMinutes}m`
    : activeScope?.label ?? 'Auto';

  return (
    <section className="assistant" aria-label="Assistant">
      <header className="assistant__head">
        <h2 className="assistant__title">Ask about this session</h2>
      </header>

      <div className="assistant__thread" ref={listRef}>
        {isEmpty ? (
          /* Full-bleed illustration stretched to touch all four sides of this
             panel, all the way down to the composer's top edge — it may run
             under the hint line below it. The tagline sits in the picture's
             left-side clear space. Decorative only. */
          <>
            <img
              src={figureUrl}
              alt=""
              aria-hidden="true"
              data-testid="assistant-figure"
              className="assistant__figure"
            />
            <p className="assistant__tagline">Больше чем слушать</p>
            {!askContext && (
              <p className="assistant__hint assistant__hint--overlay">
                Ask about the recording — answers cite the transcript.
              </p>
            )}
          </>
        ) : (
          <ul className="thread" role="list">
            {messages.map((m) => (
              <li key={m.id} className={clsx('msg', `msg--${m.role}`)}>
                <div className="msg__bubble">
                  {m.content.split('\n').map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
                {m.citations && m.citations.length > 0 && (
                  <div className="msg__cites">
                    {m.citations.map((c, i) => (
                      <button
                        key={`${c.segment_id}-${i}`}
                        className="cite tabular"
                        onClick={() => onCite(c)}
                        title={c.text}
                      >
                        <Icon name="transcript" size={12} />
                        {formatTimecode(c.start_ms)}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
            {asking && (
              <li className="msg msg--assistant">
                <div className="msg__bubble msg__bubble--typing" aria-label="Thinking">
                  <span /><span /><span />
                </div>
              </li>
            )}
          </ul>
        )}
      </div>

      {askError && (
        <p className="assistant__error" role="alert">
          {askError}
        </p>
      )}

      {askContext && (
        <div className="assistant__quote" data-testid="ask-context">
          <Icon name="notes" size={13} className="assistant__quote-icon" />
          <span className="assistant__quote-text" title={askContext.text}>
            {askContext.citation && (
              <span className="assistant__quote-time tabular">
                {formatTimecode(askContext.citation.start_ms)}
              </span>
            )}
            {askContext.text}
          </span>
          <button
            type="button"
            className="assistant__quote-clear"
            onClick={() => setAskContext(null)}
            aria-label="Remove quoted fragment"
            title="Remove quoted fragment"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      <form
        className="assistant__compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="assistant__scope" ref={scopeRef}>
          <button
            type="button"
            className="assistant__scope-trigger"
            aria-haspopup="true"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen((v) => !v)}
          >
            {scopeLabel}
            <Icon name="chevron" size={12} className="assistant__scope-chevron" />
          </button>
          {scopeOpen && (
            <div className="assistant__scope-popover">
              <div className="assistant__scopes" role="tablist" aria-label="Question scope">
                {SCOPES.map((s) => (
                  <button
                    key={s.value}
                    role="tab"
                    aria-selected={scope === s.value}
                    className={clsx('chip', scope === s.value && 'chip--on')}
                    title={s.hint}
                    onClick={() => setScope(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {windowRelevant && (
                <div className="assistant__window">
                  <span className="assistant__window-label">Window</span>
                  {WINDOW_PRESETS.map((m) => (
                    <button
                      key={m}
                      className={clsx('chip chip--sm', windowMinutes === m && 'chip--on')}
                      onClick={() => setWindow(m)}
                    >
                      {m}m
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <textarea
          ref={inputRef}
          className="assistant__input"
          value={question}
          placeholder={activeId ? 'Ask a question…' : 'Start a session to ask questions'}
          disabled={!activeId || asking}
          rows={1}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="submit"
          variant="primary"
          icon="send"
          iconFilled
          disabled={!activeId || asking || !question.trim()}
          aria-label="Send question"
        />
      </form>
    </section>
  );
}
