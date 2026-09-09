import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from './state/store';
import { useTheme } from './hooks/useTheme';
import { SessionList } from './components/sessions/SessionList';
import { RecorderBar } from './components/recorder/RecorderBar';
import { TranscriptView } from './components/transcript/TranscriptView';
import { NotesPanel } from './components/notes/NotesPanel';
import { AssistantPanel } from './components/assistant/AssistantPanel';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { Icon } from './components/ui/Icon';
import type { Citation } from './api/types';

type CenterTab = 'transcript' | 'notes';

function BackendPill() {
  const backend = useStore((s) => s.backend);
  const label =
    backend.phase === 'ready'
      ? 'Backend ready'
      : backend.phase === 'starting'
        ? 'Starting backend…'
        : backend.phase === 'error'
          ? 'Backend error'
          : 'Backend stopped';
  return (
    <span className={clsx('status-pill', `status-pill--${backend.phase}`)} title={backend.detail}>
      <Icon name="dot" size={11} filled />
      {label}
    </span>
  );
}

function BackendGate() {
  const backend = useStore((s) => s.backend);
  if (backend.phase === 'ready') return null;
  return (
    <div className="gate" role="status">
      <div className="gate__card">
        <div className={clsx('gate__spinner', backend.phase === 'error' && 'gate__spinner--error')}>
          <Icon name={backend.phase === 'error' ? 'warning' : 'dot'} size={22} />
        </div>
        <h2>
          {backend.phase === 'error' ? 'The backend didn’t start' : 'Starting AudioHelper…'}
        </h2>
        <p>
          {backend.phase === 'error'
            ? backend.detail ?? 'The local Python service failed to start.'
            : 'Launching the local transcription service and connecting securely.'}
        </p>
        {backend.phase === 'error' && (
          <p className="gate__hint">
            Ensure the Python backend is installed (uv sync in backend/). The app stays local — no fake
            results are shown.
          </p>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const init = useStore((s) => s.init);
  const theme = useStore((s) => s.theme);
  const ready = useStore((s) => s.ready);
  const activeId = useStore((s) => s.activeSessionId);
  const [tab, setTab] = useState<CenterTab>('transcript');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusSegmentId, setFocusSegmentId] = useState<string | null>(null);

  useTheme(theme);

  useEffect(() => {
    void init();
  }, [init]);

  const onCite = (citation: Citation) => {
    setTab('transcript');
    setFocusSegmentId(citation.segment_id);
    // Allow repeat clicks on the same citation to re-trigger the flash.
    window.setTimeout(() => setFocusSegmentId((cur) => (cur === citation.segment_id ? cur : cur)), 0);
  };

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar__brand">
          <span className="titlebar__mark" aria-hidden>
            <Icon name="mic" size={16} filled />
          </span>
          <span className="titlebar__name">AudioHelper</span>
        </div>
        <div className="titlebar__right">
          <BackendPill />
          <button
            className="titlebar__gear"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="settings" size={18} />
          </button>
        </div>
      </header>

      <main className="workspace">
        <SessionList />

        <section className="center" aria-label="Transcript and notes">
          <RecorderBar />
          <div className="center__tabs" role="tablist" aria-label="View">
            <button
              role="tab"
              aria-selected={tab === 'transcript'}
              className={clsx('tab', tab === 'transcript' && 'tab--on')}
              onClick={() => setTab('transcript')}
            >
              <Icon name="transcript" size={16} /> Transcript
            </button>
            <button
              role="tab"
              aria-selected={tab === 'notes'}
              className={clsx('tab', tab === 'notes' && 'tab--on')}
              onClick={() => setTab('notes')}
            >
              <Icon name="notes" size={16} /> Notes
            </button>
          </div>
          <div className="center__content">
            {!activeId ? (
              <div className="panel__center">
                <p className="loading">Select or start a session.</p>
              </div>
            ) : tab === 'transcript' ? (
              <TranscriptView focusSegmentId={focusSegmentId} />
            ) : (
              <NotesPanel />
            )}
          </div>
        </section>

        <AssistantPanel onCite={onCite} />
      </main>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {!ready && <BackendGate />}
    </div>
  );
}
