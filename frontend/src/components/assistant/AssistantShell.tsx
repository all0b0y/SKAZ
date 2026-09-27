import { useEffect, useRef, type ReactNode } from 'react';
import { clsx } from 'clsx';
import type { AskContext } from '../../state/store';
import type { Citation, Message } from '../../api/types';
import { formatTimecode } from '../../lib/time';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import figureUrl from '../../assets/images/chat-elements-girl.webp';
import { AnswerMarkdown } from './AnswerMarkdown';
import { useEdgeFade } from '../../hooks/useOverflowEdges';

// The one Assistant look shared by every engine: header, conversation,
// notices, quoted note fragment and composer. Engines only decide what goes
// into the header and which controls they actually support.

/** Which engine answers in this panel; `pending` until that is known. */
export type AssistantEngine = 'codex' | 'api_agent' | 'api' | 'pending';

export const EMPTY_HINT = 'Ask about your recordings — answers cite the transcript.';

export function AssistantShell({ engine, head, children }: { engine: AssistantEngine; head: ReactNode; children: ReactNode }) {
  return (
    <section className={clsx('assistant assistant--chat', (engine === 'codex' || engine === 'api_agent') && 'assistant--codex')}
      aria-label="Assistant" data-engine={engine}>
      <header className="assistant__head codex-head">{head}</header>
      {children}
    </section>
  );
}

/** A header title that is not a chat picker (single conversation, or engine not known yet). */
export function HeadTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return <span className="codex-head__title" title={hint}>{children}</span>;
}

/** Quoted note text travels as clearly labelled context, never as an instruction. */
export function withQuote(question: string, quote: AskContext | null): string {
  if (!quote) return question;
  const at = quote.citation ? `, ${formatTimecode(quote.citation.start_ms)}` : '';
  return `[Notes fragment${at}]\n${quote.text}\n\n${question}`;
}

interface ThreadProps {
  messages: Message[];
  activeSessionId: string | null;
  onCite: (citation: Citation) => void;
  /** Nothing to show yet: the illustrated empty state with this hint (none while a quote is parked). */
  empty: boolean;
  hint: string | null;
  /** Changes whenever new content should scroll into view. */
  scrollKey: string;
  children?: ReactNode;
}

export function ConversationThread({ messages, activeSessionId, onCite, empty, hint, scrollKey, children }: ThreadProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [scrollKey]);
  // Fade where older messages are scrolled away; the illustrated empty state has none.
  useEdgeFade(listRef, 'y', !empty);

  return (
    <div className="assistant__thread" ref={listRef}>
      {empty ? (
        <>
          <img src={figureUrl} alt="" aria-hidden="true" data-testid="assistant-figure" className="assistant__figure" />
          <p className="assistant__tagline">More than listening</p>
          {hint && <p className="assistant__hint assistant__hint--overlay">{hint}</p>}
        </>
      ) : (
        <ul className="thread" role="list">
          {messages.map((m) => (
            <MessageItem key={m.id} role={m.role} content={m.content} citations={m.citations}
              restarted={m.restarted} activeSessionId={activeSessionId} onCite={onCite} />
          ))}
          {children}
        </ul>
      )}
    </div>
  );
}

interface MessageItemProps {
  role: Message['role'];
  content: string;
  citations?: Citation[];
  restarted?: boolean;
  activeSessionId: string | null;
  onCite: (citation: Citation) => void;
}

/** Shown above an answer whose interrupted draft was thrown away and written again. */
export const RESTARTED_NOTE = 'Answer restarted after an interruption';

export function MessageItem({ role, content, citations, restarted, activeSessionId, onCite }: MessageItemProps) {
  return (
    <li className={clsx('msg', `msg--${role}`)}>
      {role === 'assistant' && restarted && <p className="msg__restarted">{RESTARTED_NOTE}</p>}
      {role === 'assistant' ? (
        <div className="msg__bubble msg__bubble--rich">
          <AnswerMarkdown content={content} citations={citations} activeSessionId={activeSessionId} onCite={onCite} />
        </div>
      ) : (
        <div className="msg__bubble">{content.split('\n').map((line, i) => <p key={i}>{line}</p>)}</div>
      )}
    </li>
  );
}

export function TypingIndicator() {
  return (
    <li className="msg msg--assistant">
      <div className="msg__bubble msg__bubble--typing" aria-label="Thinking">
        <span /><span /><span />
      </div>
    </li>
  );
}

export function AssistantError({ children }: { children: ReactNode }) {
  return <p className="assistant__error" role="alert">{children}</p>;
}

/** A full-width message above the composer, optionally with one action. */
export function AssistantNotice({ role, text, action }: {
  role: 'status' | 'alert';
  text: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="codex-notice" role={role}>
      <p>{text}</p>
      {action && <button type="button" className="btn btn--ghost" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}

export function QuoteChip({ quote, onClear }: { quote: AskContext; onClear: () => void }) {
  return (
    <div className="assistant__quote" data-testid="ask-context">
      <Icon name="notes" size={13} className="assistant__quote-icon" />
      <span className="assistant__quote-text" title={quote.text}>
        {quote.citation && (
          <span className="assistant__quote-time tabular">{formatTimecode(quote.citation.start_ms)}</span>
        )}
        {quote.text}
      </span>
      <button type="button" className="assistant__quote-clear" onClick={onClear}
        aria-label="Remove quoted fragment" title="Remove quoted fragment">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  label: string;
  sendLabel: string;
  /** The textarea accepts no input. */
  disabled: boolean;
  /** Focus the question field whenever this becomes truthy (a quote was parked). */
  focusOn?: unknown;
}

export function AssistantComposer({ value, onChange, onSubmit, placeholder, label, sendLabel, disabled, focusOn }: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focusOn) inputRef.current?.focus(); }, [focusOn]);

  return (
    <form className="assistant__compose" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <textarea
        ref={inputRef}
        className="assistant__input"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
        }}
      />
      <Button type="submit" variant="primary" icon="send" iconFilled disabled={disabled || !value.trim()}
        aria-label={sendLabel} />
    </form>
  );
}
