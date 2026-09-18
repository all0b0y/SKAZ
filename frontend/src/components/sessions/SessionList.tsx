import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import { clsx } from 'clsx';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { SessionNavigator } from './SessionNavigator';

interface SessionListProps {
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}

export function SessionList({ onOpenSettings, onOpenSearch }: SessionListProps) {
  const recorderState = useStore((s) => s.recorderState);
  const newSession = useStore((s) => s.newSession);

  const [collapsed, setCollapsed] = useState(false);
  const [creationError, setCreationError] = useState('');

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
            onClick={() => { setCreationError(''); void newSession().catch((err: unknown) => setCreationError(err instanceof Error ? err.message : String(err))); }}
            disabled={isCapturing}
            aria-label="New session"
            title={isCapturing ? 'Stop recording to start a new session' : 'New session'}
          />
        </div>
      </header>

      {creationError && <p role="alert" className="rail__notice">{creationError}</p>}
      {!collapsed && <SessionNavigator />}

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
      </div>
    </section>
  );
}
