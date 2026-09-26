import { useCodex } from '../../state/codex';
import { AssistantNotice } from './AssistantShell';
import type { ConnectionBlock } from './codexLabels';

/**
 * Why Codex cannot run, with the one action that fixes it: renew an expired
 * sign-in in place (consent was given before), or open the Codex settings.
 * While the launch check runs it only says so — no action, no error.
 */
export function CodexConnectionNotice({ block, text, onOpenSettings }: {
  block: ConnectionBlock | null;
  text: string;
  onOpenSettings?: () => void;
}) {
  const connecting = useCodex((s) => s.connecting);
  const loginWatch = useCodex((s) => s.loginWatch);
  if (block?.fix === 'relogin') {
    const waiting = loginWatch.phase === 'waiting';
    return (
      <AssistantNotice role="status"
        text={waiting ? 'Finish signing in in your browser — SKAZ updates by itself.'
          : loginWatch.phase === 'failed' ? `${text} ${loginWatch.message ?? ''}`.trim() : text}
        action={connecting ? undefined : {
          label: waiting ? 'Open the sign-in page again' : 'Sign in again',
          onClick: () => void useCodex.getState().login(),
        }} />
    );
  }
  const action = block?.fix === 'none' || !onOpenSettings ? undefined : { label: 'Open Codex settings', onClick: onOpenSettings };
  return <AssistantNotice role="status" text={text} action={action} />;
}
