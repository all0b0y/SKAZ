import { useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { SessionStatus } from '../../api/types';

const statusLabel: Record<SessionStatus, string> = {
  recording: 'Recording',
  paused: 'Paused',
  stopped: 'Saved',
};

export function SessionList() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const recorderState = useStore((s) => s.recorderState);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const removeSession = useStore((s) => s.removeSession);
  const renameSession = useStore((s) => s.renameSession);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const isCapturing =
    recorderState === 'recording' || recorderState === 'paused' || recorderState === 'processing';

  const commitRename = (id: string) => {
    const title = draft.trim();
    if (title) void renameSession(id, title);
    setEditingId(null);
  };

  return (
    <section className="rail" aria-label="Sessions">
      <header className="rail__head">
        <h2 className="rail__title">Sessions</h2>
        <Button
          variant="quiet"
          icon="plus"
          onClick={() => void newSession()}
          disabled={isCapturing}
          aria-label="New session"
          title={isCapturing ? 'Stop recording to start a new session' : 'New session'}
        />
      </header>

      {sessions.length === 0 ? (
        <p className="rail__empty">No sessions yet. Start one to begin listening.</p>
      ) : (
        <ul className="rail__list" role="list">
          {sessions.map((session) => {
            const active = session.id === activeId;
            return (
              <li key={session.id}>
                <div
                  className={clsx('session', active && 'session--active')}
                  role="button"
                  tabIndex={0}
                  aria-current={active}
                  onClick={() => void selectSession(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void selectSession(session.id);
                    }
                  }}
                >
                  <span className={clsx('session__dot', `session__dot--${session.status}`)} aria-hidden />
                  <div className="session__body">
                    {editingId === session.id ? (
                      <input
                        className="session__rename"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(session.id)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(session.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                    ) : (
                      <span
                        className="session__name"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingId(session.id);
                          setDraft(session.title);
                        }}
                      >
                        {session.title}
                      </span>
                    )}
                    <span className="session__meta tabular">{statusLabel[session.status]}</span>
                  </div>
                  <button
                    className="session__delete"
                    aria-label={`Delete ${session.title}`}
                    title="Delete session"
                    disabled={active && isCapturing}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeSession(session.id);
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
