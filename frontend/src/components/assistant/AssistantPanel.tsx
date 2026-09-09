import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/EmptyState';
import { WINDOW_PRESETS, formatTimecode } from '../../lib/time';
import type { ChatScope, Citation } from '../../api/types';

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
  const [question, setQuestion] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const messages = detail?.messages ?? [];

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, asking]);

  const submit = () => {
    if (!question.trim() || asking) return;
    void ask(question);
    setQuestion('');
  };

  const windowRelevant = scope === 'auto' || scope === 'recent';

  return (
    <section className="assistant" aria-label="Assistant">
      <header className="assistant__head">
        <h2 className="assistant__title">Ask about this session</h2>
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
      </header>

      <div className="assistant__thread" ref={listRef}>
        {messages.length === 0 && !asking ? (
          <EmptyState
            icon="search"
            title="What did I miss?"
            hint="Ask about the last few minutes, jump to the start, or search for a topic. Answers cite the transcript."
          />
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

      <form
        className="assistant__compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
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
