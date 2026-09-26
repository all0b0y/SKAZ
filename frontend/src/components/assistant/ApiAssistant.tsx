import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Icon } from '../ui/Icon';
import { AnchoredPopover, isInside } from '../ui/AnchoredPopover';
import type { ChatScope, Citation } from '../../api/types';
import {
  AssistantComposer, AssistantError, AssistantShell, ConversationThread, EMPTY_HINT, HeadTitle, QuoteChip,
  TypingIndicator, withQuote,
} from './AssistantShell';

const SCOPES: { value: ChatScope; label: string; hint: string }[] = [
  { value: 'session', label: 'Session', hint: 'The open recording' },
  { value: 'group', label: 'Group', hint: 'Recordings in the open session’s group' },
  { value: 'all', label: 'All', hint: 'All recordings in the library, including ungrouped ones' },
];

/**
 * The API (settings-selected provider) Assistant in the shared look. It has one
 * stored conversation per session and a search scope chosen per question, and
 * nothing else: no chat list, queue, stop or resume, because it cannot do them.
 */
export function ApiAssistant({ onCite }: { onCite: (citation: Citation) => void }) {
  const detail = useStore((s) => s.detail);
  const asking = useStore((s) => s.asking);
  const askError = useStore((s) => s.askError);
  const scope = useStore((s) => s.chatScope);
  const activeId = useStore((s) => s.activeSessionId);
  const setScope = useStore((s) => s.setChatScope);
  const ask = useStore((s) => s.ask);
  const askContext = useStore((s) => s.askContext);
  const setAskContext = useStore((s) => s.setAskContext);
  const [question, setQuestion] = useState('');

  const messages = detail?.messages ?? [];

  const submit = () => {
    if (!question.trim() || asking) return;
    const submittedSession = activeId;
    const pending = ask(withQuote(question, askContext));
    void pending.then(() => {
      if (useStore.getState().activeSessionId !== submittedSession || useStore.getState().askError) return;
      setQuestion('');
      setAskContext(null);
    });
  };

  return (
    <AssistantShell engine="api" head={(
      <>
        <HeadTitle hint="Each recording has one conversation with the assistant set in Settings">Session chat</HeadTitle>
        <ScopeMenu scope={scope} locked={asking} onChange={setScope} />
      </>
    )}>
      <ConversationThread messages={messages} activeSessionId={activeId} onCite={onCite}
        empty={messages.length === 0 && !asking} hint={askContext ? null : EMPTY_HINT}
        scrollKey={`${messages.length}:${asking}`}>
        {asking && <TypingIndicator />}
      </ConversationThread>
      {askError && <AssistantError>{askError}</AssistantError>}
      {askContext && <QuoteChip quote={askContext} onClear={() => setAskContext(null)} />}
      <AssistantComposer value={question} onChange={setQuestion} onSubmit={submit}
        placeholder={activeId ? 'Ask about your recordings…' : 'Start a session to ask questions'}
        label="Question" sendLabel="Send question" disabled={!activeId || asking} focusOn={askContext} />
    </AssistantShell>
  );
}

/** The search scope of the next question, in the header where Codex shows its chat scope. */
function ScopeMenu({ scope, locked, onChange }: { scope: ChatScope; locked: boolean; onChange: (scope: ChatScope) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (e.button !== 2 && !isInside(e.target, ref, popover)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const label = SCOPES.find((s) => s.value === scope)?.label ?? 'Session';
  return (
    <div className="codex-scope" ref={ref}>
      <button ref={trigger} type="button" className="codex-head__scope codex-head__scope--menu" aria-haspopup="true" aria-expanded={open}
        aria-label={`Search · ${label}`} title="Where to look for the answer to the next question" onClick={() => setOpen((v) => !v)}>
        {label}
        <Icon name="chevron" size={11} className="codex-picker__chevron" />
      </button>
      {open && (
        <AnchoredPopover ref={popover} anchorRef={trigger} align="end" className="codex-scope__popover">
          <strong>Search</strong>
          <small>New text in the selected scope is indexed when you ask.</small>
          <div className="assistant__scopes" role="group" aria-label="Search scope">
            {SCOPES.map((s) => (
              <button key={s.value} type="button" aria-pressed={scope === s.value} disabled={locked}
                className={clsx('chip', scope === s.value && 'chip--on')} title={s.hint}
                onClick={() => { onChange(s.value); setOpen(false); }}>
                {s.label}
              </button>
            ))}
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
}
