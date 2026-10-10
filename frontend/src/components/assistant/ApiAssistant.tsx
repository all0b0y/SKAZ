import { useState } from 'react';
import { useStore } from '../../state/store';
import type { Citation } from '../../api/types';
import { ScopeMenu } from './ScopeMenu';
import {
  AssistantComposer, AssistantError, AssistantShell, ConversationThread, EMPTY_HINT, HeadTitle, QuoteChip,
  TypingIndicator, withQuote,
} from './AssistantShell';

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
        <ScopeMenu scope={scope} locked={asking} onChange={setScope} label={(name) => `Search · ${name}`}
          title="Where to look for the answer to the next question" note="New text in the selected scope is indexed when you ask." />
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

