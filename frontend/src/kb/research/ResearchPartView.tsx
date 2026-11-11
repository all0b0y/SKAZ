import { useEffect, useRef, useState } from 'react';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { Button, Icon, Popover } from '../ui';
import {
  getResearchStore,
  useResearch,
  type KbResearchDecide,
  type KbResearchPermission,
} from './store';

export interface ResearchPartViewProps {
  chatId: string;
  part: KbResearchPermission;
  onOpenTask?: (taskId: string) => void;
}

/**
 * Renders a `KbResearchPermission` (`type: "research"`) message part inside a normal chat:
 * - `pending` (v4 state 06): permission card with `Allow once`, `Allow in this chat`, `Deny`
 * - `allowed` (v4 state 07): compact pointer with `Open task`
 * - `denied` / `cancelled` (v4 state 08): quiet line (`Research wasn’t started…`)
 */
export function ResearchPartView({ chatId, part, onOpenTask }: ResearchPartViewProps) {
  const { client, chats, ui } = useServices();
  const store = getResearchStore(client);
  const [current, setCurrent] = useState<KbResearchPermission>(part);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCurrent(part);
  }, [part]);

  const taskId = current.task_id;
  const storedTask = useResearch((s) => (taskId ? s.tasksById[taskId] : undefined));

  const decide = async (decision: KbResearchDecide['decision']) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await store.getState().decidePermission(current.id, decision, chatId);
      setCurrent(updated);
      chats.getState().applyPart(chatId, updated);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (current.status === 'allowed') {
    const title = storedTask?.title ?? current.task_title ?? current.arguments.description;
    const taskState = storedTask?.run.state ?? current.task_state ?? 'running';
    return (
      <div className="kb-research-pointer" data-testid="research-pointer">
        <Icon name="compass" size={18} />
        <div className="kb-research-pointer__body">
          <p className="kb-research-pointer__title">{title}</p>
          <span className="kb-research-pointer__meta">{`Research task · ${taskState}`}</span>
        </div>
        <button
          type="button"
          className="kb-research-pointer__act"
          onClick={() => {
            if (taskId) {
              ui.getState().showCenter('chat');
              store.getState().openTask(taskId);
              onOpenTask?.(taskId);
            }
          }}
        >
          Open task
        </button>
      </div>
    );
  }

  if (current.status === 'denied' || current.status === 'cancelled') {
    return (
      <p className="kb-research-denied" role="status">
        Research wasn’t started. I can help you review the materials already in your wiki.
      </p>
    );
  }

  const shownError = error ?? current.reason;

  return (
    <section className="kb-research-perm" aria-label="Research permission">
      <h3 className="kb-research-perm__title">Allow a research task?</h3>
      <p className="kb-research-perm__desc">{current.arguments.description}</p>
      {current.topics.length > 0 && (
        <ul className="kb-research-perm__topics" aria-label="Topics that will be searched">
          {current.topics.map((topic) => <li key={topic}>{topic}</li>)}
        </ul>
      )}
      <p className="kb-research-perm__meta">
        Only these topics and source identifiers go to scientific databases, never your description or your materials. Up to 30 candidates are checked against your wiki with your model allowance.
      </p>
      {shownError && (
        <p role="alert" className="kb-inline-error">
          {shownError}
        </p>
      )}
      <div className="kb-research-perm__actions">
        <Button
          variant="fill"
          disabled={busy}
          busy={busy}
          onClick={() => void decide('allow')}
        >
          Allow once
        </Button>
        <Button
          disabled={busy}
          onClick={() => void decide('allow_chat')}
        >
          Allow in this chat
        </Button>
        <Button
          disabled={busy}
          onClick={() => void decide('deny')}
        >
          Deny
        </Button>
      </div>
    </section>
  );
}

/**
 * Header chip in a normal chat when `Allow in this chat` was chosen for research tasks.
 * Clicking opens a popover to revoke the grant via `DELETE /kb/chats/{chat_id}/research-grant`.
 */
export function ResearchGrantChip({ chatId }: { chatId: string }) {
  const { client } = useServices();
  const store = getResearchStore(client);
  const allowed = useResearch((s) => s.chatGrants[chatId] === true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  // The grant lives on the server (per chat), so a reopened chat shows its chip again.
  useEffect(() => {
    void store.getState().loadGrant(chatId);
  }, [store, chatId]);

  if (!allowed) return null;

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await store.getState().revokeGrant(chatId);
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="kb-tag kb-tag--static kb-web-chip"
        aria-label="Research allowed in this chat"
        aria-expanded={open}
        onClick={() => {
          setError(null);
          setOpen((v) => !v);
        }}
      >
        <Icon name="compass" size={12} />
        <span>Research allowed</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        placement="bottom-end"
        label="Research in this chat"
        width={260}
      >
        <div className="kb-web-pop">
          <p>The agent can start research tasks in this chat without asking each time.</p>
          {error && (
            <p role="alert" className="kb-inline-error">
              {error}
            </p>
          )}
          <Button size="sm" onClick={() => void revoke()} busy={busy}>
            Ask every time again
          </Button>
        </div>
      </Popover>
    </>
  );
}
