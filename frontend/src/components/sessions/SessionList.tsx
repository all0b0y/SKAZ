import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useStore } from '../../state/store';
import { clsx } from 'clsx';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { InlineEditableText } from '../ui/InlineEditableText';
import { collectGroups, isUngrouped, parseTags, stripTags } from '../../lib/sessionTags';
import type { Session, SessionStatus } from '../../api/types';

const statusLabel: Record<SessionStatus, string> = {
  recording: 'Recording',
  paused: 'Paused',
  stopped: 'Saved',
};

/** Sentinel for the "sessions with no #tag" pseudo-group; never a real tag key. */
const UNGROUPED = '__ungrouped__';

function BackendPill({ compact }: { compact: boolean }) {
  const backend = useStore((s) => s.backend);
  const label =
    backend.phase === 'ready'
      ? 'Backend ready'
      : backend.phase === 'starting'
        ? 'Starting backend…'
        : backend.phase === 'error'
          ? 'Backend error'
          : 'Backend stopped';
  if (compact) {
    return (
      <span
        className={clsx('status-pill', 'status-pill--compact', `status-pill--${backend.phase}`)}
        title={backend.detail ? `${label} — ${backend.detail}` : label}
        role="status"
        aria-label={label}
      >
        <Icon name="dot" size={11} filled />
      </span>
    );
  }
  return (
    <span className={clsx('status-pill', `status-pill--${backend.phase}`)} title={backend.detail}>
      <Icon name="dot" size={11} filled />
      {label}
    </span>
  );
}

interface SessionListProps {
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}

function groupColorVar(colorIndex: number): string {
  return `var(--group-${colorIndex + 1})`;
}

/** First tag's color for the session row dot ring, or null if ungrouped. */
function primaryGroupColor(session: Session): string | null {
  const tags = parseTags(session.title);
  if (tags.length === 0) return null;
  const groups = collectGroups([session]);
  const first = groups.find((g) => g.key === tags[0]!.toLowerCase());
  return first ? groupColorVar(first.colorIndex) : null;
}

export function SessionList({ onOpenSettings, onOpenSearch }: SessionListProps) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const recorderState = useStore((s) => s.recorderState);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const removeSession = useStore((s) => s.removeSession);
  const renameSession = useStore((s) => s.renameSession);

  const [collapsed, setCollapsed] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === '/') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const isCapturing =
    recorderState === 'recording' || recorderState === 'paused' || recorderState === 'processing';

  const groups = useMemo(() => collectGroups(sessions), [sessions]);
  const hasUngrouped = useMemo(() => sessions.some((s) => isUngrouped(s)), [sessions]);
  const ungroupedCount = useMemo(
    () => sessions.filter((s) => isUngrouped(s)).length,
    [sessions],
  );

  const visibleSessions = useMemo(() => {
    if (activeFilter === null) return sessions;
    if (activeFilter === UNGROUPED) return sessions.filter((s) => isUngrouped(s));
    return sessions.filter((s) => parseTags(s.title).some((t) => t.toLowerCase() === activeFilter));
  }, [sessions, activeFilter]);

  return (
    <section className={clsx('rail', collapsed && 'rail--collapsed')} aria-label="Sessions">
      <header className="rail__head">
        {!collapsed && <h2 className="rail__title">Sessions</h2>}
        <div className="rail__head-actions">
          <button
            className="rail__collapse"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sessions panel' : 'Collapse sessions panel'}
            aria-pressed={collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} panel (⌘/)`}
          >
            <Icon name="chevron" size={14} className={clsx('rail__collapse-icon', collapsed && 'rail__collapse-icon--flipped')} />
          </button>
          <Button
            variant="quiet"
            icon="plus"
            onClick={() => void newSession()}
            disabled={isCapturing}
            aria-label="New session"
            title={isCapturing ? 'Stop recording to start a new session' : 'New session'}
          />
        </div>
      </header>

      {!collapsed && (groups.length > 0 || hasUngrouped) && (
        <div className="rail__chips" role="tablist" aria-label="Session groups">
          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === null}
            className={clsx('chip', 'chip--all', activeFilter === null && 'chip--active')}
            onClick={() => setActiveFilter(null)}
          >
            All <span className="chip__count">{sessions.length}</span>
          </button>
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              role="tab"
              aria-selected={activeFilter === group.key}
              className={clsx('chip', activeFilter === group.key && 'chip--active')}
              style={{ '--chip-color': groupColorVar(group.colorIndex) } as CSSProperties}
              onClick={() => setActiveFilter(group.key)}
              title={`#${group.label} · ${group.count}`}
            >
              <span className="chip__dot" aria-hidden />
              #{group.label} <span className="chip__count">{group.count}</span>
            </button>
          ))}
          {hasUngrouped && (
            <button
              type="button"
              role="tab"
              aria-selected={activeFilter === UNGROUPED}
              className={clsx('chip', 'chip--ungrouped', activeFilter === UNGROUPED && 'chip--active')}
              onClick={() => setActiveFilter(UNGROUPED)}
              title={`Ungrouped · ${ungroupedCount}`}
            >
              <span className="chip__dot chip__dot--ungrouped" aria-hidden />
              Ungrouped <span className="chip__count">{ungroupedCount}</span>
            </button>
          )}
        </div>
      )}

      {!collapsed && (
        visibleSessions.length === 0 ? (
          <p className="rail__empty">
            {sessions.length === 0
              ? 'No sessions yet. Start one to begin listening.'
              : 'No sessions in this group.'}
          </p>
        ) : (
          <ul className="rail__list" role="list">
            {visibleSessions.map((session) => {
              const active = session.id === activeId;
              const ringColor = primaryGroupColor(session);
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
                    <span
                      className={clsx('session__marker', ringColor && 'session__marker--grouped')}
                      style={ringColor ? ({ '--group-ring-color': ringColor } as CSSProperties) : undefined}
                      aria-hidden
                    >
                      <span className={clsx('session__dot', `session__dot--${session.status}`)} />
                    </span>
                    <div className="session__body">
                      <InlineEditableText
                        value={stripTags(session.title)}
                        onCommit={(title) => void renameSession(session.id, title)}
                        className="session__name"
                        inputClassName="session__rename"
                        ariaLabel={`Rename ${session.title}`}
                      />
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
        )
      )}

      <div className={clsx('rail__foot', collapsed && 'rail__foot--collapsed')}>
        <button
          className="rail__foot-btn"
          onClick={onOpenSearch}
          aria-label="Search materials"
          title="Search (⌘K)"
        >
          <Icon name="search" size={16} />
        </button>
        <button
          className="rail__foot-btn"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
        >
          <Icon name="settings" size={16} />
        </button>
        <BackendPill compact={collapsed} />
      </div>
    </section>
  );
}
