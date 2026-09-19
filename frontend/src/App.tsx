import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from './state/store';
import { useTheme } from './hooks/useTheme';
import { SessionList } from './components/sessions/SessionList';
import { BackendStatusDot } from './components/sessions/BackendStatusDot';
import { LanguageOnboarding } from './components/onboarding/LanguageOnboarding';
import { ImportPanel } from './components/imports/ImportPanel';
import { RecorderBar } from './components/recorder/RecorderBar';
import { TranscriptView } from './components/transcript/TranscriptView';
import { NotesPanel } from './components/notes/NotesPanel';
import { AssistantPanel } from './components/assistant/AssistantPanel';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { SearchPalette } from './components/search/SearchPalette';
import { Icon } from './components/ui/Icon';
import type { Citation } from './api/types';

type CenterTab = 'transcript' | 'notes';

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
          {backend.phase === 'error' ? 'The backend didn’t start' : 'Starting SKAZ…'}
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
  const settings = useStore((s) => s.settings);
  const imports = useStore((s) => s.imports);
  const trackImport = useStore((s) => s.trackImport);
  const selectSession = useStore((s) => s.selectSession);
  const refreshSessions = useStore((s) => s.refreshSessions);
  const activeImport = activeId ? imports[activeId] : undefined;
  const [tab, setTab] = useState<CenterTab>('transcript');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusSegmentId, setFocusSegmentId] = useState<string | null>(null);

  useTheme(theme);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    // A new import (fresh or retried) becomes the visible session immediately,
    // so the user lands on its state instead of an empty transcript.
    const onStarted = (event: Event) => {
      const created = (event as CustomEvent).detail as
        | { session: { id: string }; import_state: import('./api/types').ImportView }
        | undefined;
      if (!created) return;
      trackImport(created.import_state);
      void refreshSessions();
      void selectSession(created.session.id);
    };
    window.addEventListener('skaz-import-started', onStarted);
    return () => window.removeEventListener('skaz-import-started', onStarted);
  }, [trackImport, refreshSessions, selectSession]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onCite = (citation: Citation) => {
    setTab('transcript');
    setFocusSegmentId(citation.segment_id);
    // Allow repeat clicks on the same citation to re-trigger the flash.
    window.setTimeout(() => setFocusSegmentId((cur) => (cur === citation.segment_id ? cur : cur)), 0);
  };

  return (
    <div className="app">
      <header className="titlebar">
        <BackendStatusDot />
      </header>

      <main className="workspace">
        <SessionList onOpenSettings={() => setSettingsOpen(true)} onOpenSearch={() => setSearchOpen(true)} />

        <section className="center" aria-label="Transcript and notes">
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
            ) : activeImport ? (
              // An unfinished import owns the main area: there is no transcript
              // to show yet, and the cancel action has to live somewhere real.
              <ImportPanel
                sessionId={activeId}
                onSettled={(state) => {
                  trackImport(state);
                  if (state.status === 'completed') void selectSession(state.session_id);
                }}
                onDeleted={() => { void refreshSessions(); }}
              />
            ) : tab === 'transcript' ? (
              <TranscriptView focusSegmentId={focusSegmentId} />
            ) : (
              <NotesPanel onCite={onCite} onOpenSettings={() => setSettingsOpen(true)} />
            )}
          </div>
          <div className="center__footer">
            <RecorderBar />
          </div>
        </section>

        <AssistantPanel onCite={onCite} />
      </main>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onCite={onCite} />
      {!ready && <BackendGate />}
      {/* Only once the backend answered: the language list comes from it. */}
      {ready && settings && !settings.used_languages?.length && <LanguageOnboarding />}
    </div>
  );
}
