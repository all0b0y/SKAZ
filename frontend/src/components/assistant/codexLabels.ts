import type { CodexConnection, CodexScope, CodexTask, CodexTaskStatus } from '../../api/codex';

export const SCOPE_LABEL: Record<CodexScope, string> = { session: 'Session', group: 'Group', all: 'All' };
export const SCOPE_HINT: Record<CodexScope, string> = {
  session: 'The open recording only',
  group: 'Recordings in the open session’s group',
  all: 'All recordings in the library',
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

/** Only the connection states that make a send pointless block the composer. */
export function connectionBlock(connection: CodexConnection | null): string | null {
  switch (connection?.status) {
    case 'missing': return 'Codex was not found on this computer.';
    case 'incompatible': return `The installed Codex version${connection.version ? ` ${connection.version}` : ''} is incompatible.`;
    case 'signed_out': return 'No ChatGPT account connected.';
    default: return null;
  }
}
