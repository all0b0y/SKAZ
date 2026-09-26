import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { isActive, type CodexTask } from '../../api/codex';
import type { Session } from '../../api/types';
import { STATUS_LABEL, taskTitle } from './codexLabels';
import { AnchoredPopover, isInside } from '../ui/AnchoredPopover';

interface Props {
  tasks: CodexTask[];
  sessions: Session[];
  onStop: (taskId: string) => void;
  onResume: (taskId: string) => void;
}

/**
 * The app-wide queue: one Codex task runs at a time, the rest wait here, and
 * interrupted ones wait for a manual "Продолжить". Visible from every session,
 * because a task keeps running while the user reads something else.
 */
export function CodexQueue({ tasks, sessions, onStop, onResume }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const shown = tasks.filter((t) => isActive(t) || t.status === 'paused');
  const running = shown.some((t) => t.status === 'running' || t.status === 'preparing');

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (e.button !== 2 && !isInside(e.target, ref, popover)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  if (shown.length === 0) return null;
  const title = (id: string | undefined) => sessions.find((s) => s.id === id)?.title ?? 'Recording';

  return (
    <div className="codex-queue" ref={ref}>
      <button ref={trigger} type="button" className="codex-queue__trigger" aria-expanded={open} aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}>
        <span className={clsx('codex-task__dot', running && 'codex-task__dot--live')} aria-hidden="true" />
        Queue · {shown.length}
      </button>
      {open && (
        <AnchoredPopover ref={popover} anchorRef={trigger} align="end" className="codex-queue__popover" role="dialog" aria-label="Codex queue">
          <strong>Codex queue</strong>
          <small>One task runs at a time. Interrupted tasks resume only manually.</small>
          <ul className="codex-queue__list">
            {shown.map((task) => (
              <li key={task.id} className="codex-queue__item" data-status={task.status}>
                <div className="codex-queue__text">
                  <span className="codex-queue__title" title={taskTitle(task)}>{taskTitle(task)}</span>
                  <small>{STATUS_LABEL[task.status]} · {task.kind === 'notes' ? 'Notes' : 'Chat'} · {title(task.session_ids[0])}</small>
                </div>
                {isActive(task) && task.status !== 'stopping' && (
                  <button type="button" className="btn btn--quiet" onClick={() => onStop(task.id)}>
                    {task.status === 'running' ? 'Stop' : 'Cancel'}
                  </button>
                )}
                {task.status === 'paused' && (
                  <button type="button" className="btn btn--ghost" onClick={() => onResume(task.id)}>Continue</button>
                )}
              </li>
            ))}
          </ul>
        </AnchoredPopover>
      )}
    </div>
  );
}
