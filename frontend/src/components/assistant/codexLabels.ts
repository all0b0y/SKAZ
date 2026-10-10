import type { CodexConnection, CodexScope, CodexTask, CodexTaskStatus, GroupScope } from '../../api/codex';

export const SCOPE_LABEL: Record<CodexScope, string> = { session: 'Session', group: 'Group', all: 'All' };
export const SCOPE_HINT: Record<CodexScope, string> = {
  session: 'The open recording only',
  group: 'Recordings in the open session’s group',
  all: 'All recordings in the library',
};

/** Why a new chat of this session cannot use Group; the backend refuses with the same words. */
export const GROUP_SCOPE_REASON: Record<Exclude<GroupScope, 'available'>, string> = {
  storage_off: 'Group chats need file mode (Settings → Files) and this session in a group.',
  not_in_group: 'This session isn’t in a group. Add it to one in the sidebar to start a Group chat.',
};

export const STATUS_LABEL: Record<CodexTaskStatus, string> = {
  preparing: 'Capturing the recording',
  queued: 'Queued',
  running: 'Running',
  stopping: 'Stopping',
  paused: 'Paused',
  completed: 'Done',
  failed: 'Error',
  cancelled: 'Stopped',
};

/** Why a partial answer is not a complete one, in the words shown under it. */
export const UNFINISHED_NOTE: Partial<Record<CodexTaskStatus, string>> = {
  paused: 'Answer unfinished: the task was interrupted and waits to be resumed manually.',
  failed: 'Answer unfinished because of an error.',
  cancelled: 'Answer unfinished: the task was stopped.',
};

export const taskTitle = (task: CodexTask): string =>
  task.kind === 'notes' ? 'Recording notes' : task.question.trim() || 'Question';

/**
 * Why Codex cannot run right now, and what fixes it. `checking` blocks quietly
 * while the launch check runs; `relogin` means one click renews an expired
 * sign-in (consent was already given); `settings` sends the user to the Codex tab.
 */
export interface ConnectionBlock {
  text: string;
  fix: 'none' | 'relogin' | 'settings';
}

export function connectionBlockOf(connection: CodexConnection | null): ConnectionBlock | null {
  switch (connection?.status) {
    case undefined:
    case 'unchecked':
    case 'checking': return { text: 'Checking Codex…', fix: 'none' };
    case 'missing': return { text: 'Codex was not found on this computer.', fix: 'settings' };
    case 'incompatible': return {
      // The backend names the reason: outdated (with the minimum) or an unexpected reply format.
      text: connection.error
        ?? `The installed Codex version${connection.version ? ` ${connection.version}` : ''} cannot be used.`,
      fix: 'settings',
    };
    case 'signed_out': return connection.relogin_available
      ? { text: 'Your ChatGPT sign-in has expired.', fix: 'relogin' }
      : { text: 'No ChatGPT account connected.', fix: 'settings' };
    case 'error': return { text: `Codex check failed: ${connection.error ?? 'no details'}`, fix: 'settings' };
    default: return null;
  }
}

/** Only the connection states that make a send pointless block the composer. */
export function connectionBlock(connection: CodexConnection | null): string | null {
  return connectionBlockOf(connection)?.text ?? null;
}
