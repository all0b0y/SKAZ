import { useEffect, type ReactNode } from 'react';
import { useStore } from '../../state/store';
import type { Citation } from '../../api/types';
import { selectCodexAssistant, useCodex } from '../../state/codex';
import { ApiAssistant } from './ApiAssistant';
import { AssistantComposer, AssistantNotice, AssistantShell, ConversationThread, HeadTitle } from './AssistantShell';
import { CodexAssistant } from './CodexAssistant';

interface AssistantPanelProps {
  onCite: (citation: Citation) => void;
  onOpenSettings?: () => void;
}

/**
 * One Assistant look for every engine. Codex when the backend serves it and the
 * user chose it for Assistant; otherwise the API provider from settings. Until
 * that choice is known — or when it cannot be read — nothing is sent, and the
 * panel says why instead of quietly answering through either engine.
 */
export function AssistantPanel({ onCite, onOpenSettings }: AssistantPanelProps) {
  const ready = useStore((s) => s.ready);
  const activeId = useStore((s) => s.activeSessionId);
  const availability = useCodex((s) => s.availability);
  const reason = useCodex((s) => s.unavailableReason);
  const codexOn = useCodex(selectCodexAssistant);
  const load = useCodex((s) => s.load);

  useEffect(() => {
    if (ready) void load(activeId);
  }, [ready, activeId, load]);

  if (availability === 'unknown') {
    return <EngineUnknown notice={<AssistantNotice role="status" text="Loading the assistant…" />} />;
  }
  if (availability === 'error') {
    return (
      <EngineUnknown notice={(
        <AssistantNotice role="alert"
          text={`Could not read the Codex status: ${reason}. Questions are not sent until the assistant engine is known.`}
          action={{ label: 'Retry', onClick: () => void load(activeId) }} />
      )} />
    );
  }
  return codexOn
    ? <CodexAssistant onCite={onCite} onOpenSettings={onOpenSettings} />
    : <ApiAssistant onCite={onCite} />;
}

/** The shared shell with a disabled composer while the answering engine is not known. */
function EngineUnknown({ notice }: { notice: ReactNode }) {
  return (
    <AssistantShell engine="pending" head={<HeadTitle>Assistant</HeadTitle>}>
      <ConversationThread messages={[]} activeSessionId={null} onCite={() => undefined} empty hint={null} scrollKey="" />
      {notice}
      <AssistantComposer value="" onChange={() => undefined} onSubmit={() => undefined}
        placeholder="Ask about your recordings…" label="Question" sendLabel="Send question" disabled />
    </AssistantShell>
  );
}
