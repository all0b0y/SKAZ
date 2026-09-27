import { clsx } from 'clsx';
import { isActive, type CodexTask } from '../../api/codex';
import type { Citation } from '../../api/types';
import { AnswerMarkdown } from './AnswerMarkdown';
import { RESTARTED_NOTE } from './AssistantShell';
import { STATUS_LABEL, UNFINISHED_NOTE } from './codexLabels';

interface Props {
  task: CodexTask;
  activeSessionId: string | null;
  /** Revoked chats are view-only: no resume. */
  readOnly: boolean;
  onCite: (citation: Citation) => void;
  onStop: (taskId: string) => void;
  onResume: (taskId: string) => void;
  /** Where another model is chosen; offered when an API-provider run ends in an error. */
  onOpenSettings?: () => void;
}

/**
 * The one unfinished task of a chat: its live answer, what it is actually doing,
 * and the controls that apply to its state.
 *
 * The answer is the backend's cumulative text, replaced on every read. Anything
 * that ended without completing says so under the text, so a partial answer can
 * never be mistaken for a complete one. The journal lists recorded tool work
 * only — there is no invented progress and no model reasoning here.
 */
export function CodexTaskCard({ task, activeSessionId, readOnly, onCite, onStop, onResume, onOpenSettings }: Props) {
  const active = isActive(task);
  const latest = task.activity.at(-1);
  const unfinished = UNFINISHED_NOTE[task.status];
  // A refused API task (a spent budget) failed for good: only a new question helps.
  const canResume = !readOnly && (task.status === 'paused' || (task.status === 'failed' && task.engine !== 'api'));
  // An API-provider error is shown with its two ways out: the same model again, or another one.
  const apiError = task.engine === 'api' && !!task.error && (task.status === 'paused' || task.status === 'failed');

  return (
    <li className={clsx('msg msg--assistant codex-task', `codex-task--${task.status}`)} data-testid="codex-task">
      <div className="codex-task__status" role="status" aria-live="polite">
        <span className={clsx('codex-task__dot', active && 'codex-task__dot--live')} aria-hidden="true" />
        <span className="codex-task__label">{STATUS_LABEL[task.status]}</span>
        {active && latest && <span className="codex-task__activity" title={latest}>· {latest}</span>}
        {active && task.status !== 'stopping' && (
          <button type="button" className="btn btn--quiet codex-task__action" onClick={() => onStop(task.id)}>
            {task.status === 'running' ? 'Stop' : 'Cancel'}
          </button>
        )}
        {canResume && (
          <button type="button" className="btn btn--ghost codex-task__action" onClick={() => onResume(task.id)}>
            {apiError ? 'Retry' : 'Continue'}
          </button>
        )}
        {apiError && onOpenSettings && (
          <button type="button" className="btn btn--quiet codex-task__action" onClick={onOpenSettings}>
            Choose another model
          </button>
        )}
        {task.status === 'paused' && (
          <button type="button" className="btn btn--quiet codex-task__action" onClick={() => onStop(task.id)}>
            Cancel
          </button>
        )}
      </div>

      {task.restarted && <p className="msg__restarted">{RESTARTED_NOTE}</p>}
      {task.answer ? (
        <div className={clsx('msg__bubble msg__bubble--rich', unfinished && 'codex-task__partial')}>
          <AnswerMarkdown content={task.answer} citations={task.citations} activeSessionId={activeSessionId} onCite={onCite} />
        </div>
      ) : active ? (
        <div className="msg__bubble msg__bubble--typing" aria-label="Answer in progress">
          <span /><span /><span />
        </div>
      ) : null}

      {unfinished && <p className="codex-task__note">{unfinished}</p>}
      {task.error && <p className="codex-task__error" role="alert">{task.error}</p>}

      {task.activity.length > 0 && (
        <details className="codex-task__journal">
          <summary>Activity log · {task.activity.length}</summary>
          <ol>
            {task.activity.map((entry, index) => <li key={index}>{entry}</li>)}
          </ol>
        </details>
      )}
    </li>
  );
}
