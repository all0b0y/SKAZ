import { useEffect, useState, type KeyboardEvent } from 'react';
import { StippleGlobe } from '../fx/stipple/StippleWork';
import { useChats, useServices }  from '../state/context';
import { Button, Icon, Spinner } from '../ui';
import {
  getResearchStore,
  useResearch,
  type KbResearchTask,
  type ResearchStopReason,
} from './store';

import { ResearchFunnel } from './ResearchFunnel';
import { useFinishedTaskRead } from './seen';

export const RESEARCH_POLL_MS = 1000;

export function statusHeadingFor(task: KbResearchTask): string {
  const { state, stop_reason } = task.run;
  if (state === 'running' || state === 'queued') return 'Checking against your wiki';
  switch (stop_reason) {
    case 'budget':
      return 'Paused · batch complete';
    case 'user_pause':
      return 'Paused by you';
    case 'app_exit':
      return 'Paused when SKAZ closed';
    case 'decision_model_required':
      return 'Paused · decision model required';
    case 'science_consent_required':
      return 'Paused · scientific search is off';
    case 'openalex_daily_limit':
      return 'Paused · OpenAlex daily limit reached';
    case 'provider_unavailable':
      return 'Paused · database unavailable';
    case 'completed':
      return 'Research complete';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Stopped · error';
    default:
      if (state === 'done') return 'Research complete';
      if (state === 'cancelled') return 'Cancelled';
      if (state === 'error') return 'Stopped · error';
      return 'Paused by you';
  }
}

export function stopReasonCopyFor(reason: ResearchStopReason): string | null {
  switch (reason) {
    case 'decision_model_required':
      return 'Choose a model for Decisions in Settings → Models to compare candidates with your wiki.';
    case 'science_consent_required':
      return 'Allow scientific database queries in Settings → Search to run this check.';
    case 'openalex_daily_limit':
      return 'OpenAlex daily limit reached. Add a free OpenAlex key in Settings → Search, or continue tomorrow.';
    case 'provider_unavailable':
      return 'The scientific database did not respond. Your previous findings are kept.';
    case 'app_exit':
      return 'SKAZ was closed while this ran. Free steps go on by themselves; paid checks wait for your Continue.';
    case 'failed':
      return 'The research task stopped because of an error.';
    default:
      return null;
  }
}

export const DECISION_CHOICE_LABELS = {
  download_local: 'Download a local model',
  openrouter_jev: 'Use OpenRouter · Jev (paid)',
} as const;

/** "Try again after 14:30" / "…after 11 Nov, 02:00", from `retry_at`; null when the server gave none. */
export function retryCopyFor(retryAt: string | null): string | null {
  if (!retryAt) return null;
  const at = new Date(retryAt);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay = at.toDateString() === new Date().toDateString();
  const when = at.toLocaleString(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Try again after ${when}.`;
}

export function postProgressCopyFor(task: KbResearchTask): string {
  const { state, stop_reason } = task.run;
  if (state === 'running' || state === 'queued') {
    return 'You can leave this chat. Findings appear in Explore as they are ready.';
  }
  if (state === 'done' || stop_reason === 'budget' || stop_reason === 'completed') {
    return 'This batch is finished. Your findings are ready to explore.';
  }
  if (state === 'error' || stop_reason === 'failed') {
    return 'The task stopped before it finished. Findings already kept remain in Explore.';
  }
  if (state === 'cancelled' || stop_reason === 'cancelled') {
    return 'This research task was cancelled. Any findings already kept remain in Explore.';
  }
  return 'Your findings are kept. Continue whenever you’re ready.';
}

/**
 * Opens Explore. The rail section arrives with F1; until its type is merged, the value is set
 * through one cast here so nothing else in F2 depends on it.
 */
function openExploreSection(prefs: ReturnType<typeof useServices>['prefs']): void {
  prefs.getState().set({ section: 'explore' });
}

export interface ResearchTaskViewProps {
  taskId?: string | null;
  initialTask?: KbResearchTask;
  onOpenFindings?: (taskId: string) => void;
}

/**
 * Mockup v4 states `03` (running), `04` (paused), `05` (budget reached), plus `done` and honest
 * stop states (`decision_model_required`, `science_consent_required`, `openalex_daily_limit`,
 * `provider_unavailable`). Polls `GET /kb/explore/jobs` ~1/s while visible and running.
 */
export function ResearchTaskView({ taskId, initialTask, onOpenFindings }: ResearchTaskViewProps) {
  const { client, ui, prefs, chats } = useServices();
  const store = getResearchStore(client);
  const activeTaskId = useResearch((s) => s.activeTaskId);
  const resolvedId = taskId ?? initialTask?.id ?? activeTaskId;
  const storedTask = useResearch((s) => (resolvedId ? s.tasksById[resolvedId] : s.tasks[0]));
  const task = storedTask ?? initialTask ?? null;
  const chatTitle = useChats((s) => s.list.find((chat) => chat.id === task?.chat_id)?.title);
  useFinishedTaskRead(task);
  const busy = useResearch((s) => s.busy);
  const error = useResearch((s) => s.error);
  const [followUpText, setFollowUpText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (initialTask) {
      store.getState().upsertTask(initialTask);
      return;
    }
    if (resolvedId) {
      if (!store.getState().tasksById[resolvedId]) {
        void store.getState().loadTask(resolvedId);
      }
    } else {
      void store.getState().loadTasks();
    }
  }, [initialTask, resolvedId, store]);

  const isRunning = task?.run.state === 'running' || task?.run.state === 'queued';
  const currentTaskId = task?.id ?? null;

  useEffect(() => {
    if (!isRunning || !currentTaskId) return undefined;
    let timer: number | null = null;

    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void store.getState().pollProgress(currentTaskId);
    };

    const startTimer = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = window.setInterval(tick, RESEARCH_POLL_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      } else {
        tick();
        startTimer();
      }
    };

    startTimer();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isRunning, currentTaskId, store]);

  if (!task) {
    return (
      <>
        <header className="kb-head kb-head--chat">
          <h1 className="kb-head__title">Research task</h1>
          <div className="kb-head__spacer" />
        </header>
        <div className="kb-chat__wait">
          <Spinner label="Loading research task…" />
        </div>
      </>
    );
  }

  const { run } = task;
  const limit = run.budget.limit || 30;
  const used = Math.min(limit, Math.max(0, run.budget.used));
  const isBudgetStop = run.stop_reason === 'budget';
  const isCompleted = run.state === 'done' || run.stop_reason === 'completed';
  const isFailed = run.state === 'error' || run.stop_reason === 'failed';
  const isPaused = run.state === 'paused';
  const stopCopy = stopReasonCopyFor(run.stop_reason);
  const retryCopy = run.stop_reason === 'openalex_daily_limit' ? retryCopyFor(run.retry_at) : null;
  const needsDecisionModel = run.stop_reason === 'decision_model_required';

  const handleViewFindings = () => {
    if (onOpenFindings) onOpenFindings(task.id);
    else openExploreSection(prefs);
  };

  // The task is a chat of its own (`chat_id`): a follow-up is a real message there, and the centre
  // shows that chat from then on.
  const handleSendFollowUp = async () => {
    const text = followUpText.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    chats.getState().open(task.chat_id);
    const res = await chats.getState().send({ text, mentions: [], quotes: [], attachments: [] }, {});
    setSending(false);
    if (!res.ok) {
      setSendError(res.error);
      return;
    }
    setFollowUpText('');
    store.getState().close();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSendFollowUp();
    }
  };

  const openSearchSettings = () => {
    ui.getState().openSettings('search');
  };

  return (
    <>
      <header className="kb-head kb-head--chat">
        <h1 className="kb-head__title">{chatTitle ?? task.title}</h1>
        <div className="kb-head__spacer" />
      </header>
      <div className="kb-research-scroll" role="log" aria-label="Research task">
        <div className="kb-research-content">
          <div className="kb-research-user">{task.description}</div>
          <div className="kb-research-assistant-label">SKAZ · Research task</div>
          <p className="kb-research-paragraph">
            I’m looking for new evidence and disagreements with your existing sources.
          </p>

          <section className="kb-research-progress" aria-label="Research progress">
            <div className="kb-research-progress__status">
              {isRunning ? (
                <StippleGlobe className="kb-research-globe" />
              ) : isCompleted ? (
                <Icon name="check" size={16} />
              ) : isFailed ? (
                <Icon name="warning" size={16} />
              ) : (
                <Icon name="clock" size={16} />
              )}
              <strong>{statusHeadingFor(task)}</strong>
            </div>

            <div className="kb-research-progress__funnel">
              {`${run.counters.checked} found → ${run.counters.on_topic} fit → ${run.counters.new} new`}
            </div>

            <div className="kb-research-progress__meta">
              {`${used} of ${limit} candidates compared with your wiki`}
            </div>

            <div className="kb-research-dots" aria-hidden="true">
              {Array.from({ length: limit }, (_, idx) => (
                <i key={idx} className={idx < used ? 'done' : ''} />
              ))}
            </div>

            {stopCopy && (
              <p className="kb-research-progress__stop" role="status">
                {stopCopy}
                {retryCopy && ` ${retryCopy}`}
              </p>
            )}

            <div className="kb-research-progress__actions">
              {run.state === 'running' && (
                <>
                  <Button disabled={busy} onClick={() => void store.getState().pauseTask(task.id)}>
                    Pause
                  </Button>
                  <span className="kb-research-progress__note">
                    {`Budget: ${limit} candidate checks per batch`}
                  </span>
                </>
              )}

              {isPaused && needsDecisionModel && (
                <>
                  {run.decision_choices.map((choice) => (
                    <Button
                      key={choice}
                      disabled={busy}
                      onClick={() => void store.getState().resumeTask(task.id, choice)}
                    >
                      {DECISION_CHOICE_LABELS[choice]}
                    </Button>
                  ))}
                  <Button variant="quiet" onClick={() => ui.getState().openSettings('models')}>
                    Open Settings → Models
                  </Button>
                </>
              )}

              {isPaused && !needsDecisionModel && (
                <>
                  <Button disabled={busy} onClick={() => void store.getState().resumeTask(task.id)}>
                    {isBudgetStop ? `Continue · next ${limit}` : 'Continue'}
                  </Button>
                  {run.stop_reason === 'science_consent_required' && (
                    <Button onClick={openSearchSettings}>Open Settings → Search</Button>
                  )}
                  {run.stop_reason === 'openalex_daily_limit' && (
                    <Button onClick={openSearchSettings}>Add key in Settings</Button>
                  )}
                  <span className="kb-research-progress__note">
                    {isBudgetStop
                      ? 'A new batch uses your model allowance.'
                      : `${run.budget.remaining} candidate checks remain in this batch.`}
                  </span>
                </>
              )}

              {isPaused && (
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => void store.getState().cancelTask(task.id)}
                >
                  Cancel
                </Button>
              )}
            </div>
          </section>
          <ResearchFunnel key={run.id} runId={run.id} taskId={task.id} updatedAt={run.updated_at} />
          {task.topics.length > 0 && <p className="kb-research-perm__meta">Topics: {task.topics.map((topic) => topic.text).join(' · ')}</p>}

          {error && (
            <p role="alert" className="kb-inline-error">
              {error}
            </p>
          )}

          <p className="kb-research-paragraph">{postProgressCopyFor(task)}</p>

          <div className="kb-research-pointer">
            <Icon name="compass" size={18} />
            <div className="kb-research-pointer__body">
              <p className="kb-research-pointer__title">{task.title}</p>
              <span className="kb-research-pointer__meta">Findings in Explore → New</span>
            </div>
            <button
              type="button"
              className="kb-research-pointer__act"
              onClick={handleViewFindings}
            >
              View findings
            </button>
          </div>

          <div className="kb-research-composer kb-research-composer--compact">
            <textarea
              className="kb-research-composer__input"
              aria-label="Message research task"
              placeholder="Refine the task or ask about a finding…"
              value={followUpText}
              onChange={(e) => setFollowUpText(e.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            {sendError && (
              <p role="alert" className="kb-inline-error">
                {sendError}
              </p>
            )}
            <div className="kb-research-composer__actions">
              <Button disabled={!followUpText.trim() || sending} busy={sending} onClick={() => void handleSendFollowUp()}>
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
