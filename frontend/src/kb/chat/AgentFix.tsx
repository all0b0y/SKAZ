import type { KbAgent } from '../../api/kb/types.gen';
import { useServices } from '../state/context';

/** What fixes an agent that can't answer, in the words of its own Settings row (QA D6). */
export function agentFixLabel(agent: KbAgent | undefined): string {
  switch (agent?.action) {
    case 'install': return 'Install in Settings';
    case 'update': return 'Update in Settings';
    case 'login': return 'Sign in in Settings';
    default: return 'Open Accounts & keys';
  }
}

/** A button next to an agent error that opens Settings → Accounts & keys, where the agent is set up. */
export function AgentFix({ agent, onOpen }: { agent: KbAgent | undefined; onOpen?: () => void }) {
  const { ui } = useServices();
  return (
    <button type="button" className="kb-linkbtn kb-agentfix"
      onClick={() => { onOpen?.(); ui.getState().openSettings('conn'); }}>
      {agentFixLabel(agent)}…
    </button>
  );
}
