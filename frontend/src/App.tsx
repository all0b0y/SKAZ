import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
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
import { WebSearchApproval } from './components/web/WebSearchApproval';
import { ProactiveCards } from './components/proactive/ProactiveCards';
import { SearchPalette } from './components/search/SearchPalette';
import { Icon } from './components/ui/Icon';
import { PanelResizer, TitlebarLeading, TitlebarTrailing } from './components/layout/PanelChrome';
import { usePanelLayout } from './hooks/usePanelLayout';
import type { PanelId, PanelView } from './lib/panelLayout';
import type { Citation } from './api/types';
import type { SectionId } from './components/settings/SettingsPanel';
import { useCitationFocus } from './hooks/useCitationFocus';
import { OPEN_SETTINGS_EVENT } from './lib/openSettings';

type CenterTab = 'transcript' | 'notes';

/**
 * A side panel's place in the grid. It stays mounted while hidden, so a
 * half-typed question or scroll position survives closing it; hidden panels
 * are removed from the accessibility tree and focus order by CSS visibility.
 */
function PanelSlot({ id, view, children }: { id: PanelId; view: PanelView; children: ReactNode }) {
  const state = view.docked ? 'docked' : view.overlay ? 'overlay' : 'closed';
  return (
    <div
      className={clsx('panel-slot', `panel-slot--${id}`, `panel-slot--${state}`)}
      data-panel={id}
      data-pane={id}
      data-state={state}
      aria-hidden={state === 'closed' || undefined}
    >
      <div className="panel-slot__inner">{children}</div>
    </div>
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
  const importsRunning = Object.values(imports).some((s) => ['queued', 'downloading', 'preparing', 'uploading', 'processing'].includes(s.status));
  useEffect(() => {
    if (!importsRunning) return;
    const timer = setInterval(() => { void useStore.getState().refreshImports(); }, 2000);
    return () => clearInterval(timer);
  }, [importsRunning]);
  const [tab, setTab] = useState<CenterTab>('transcript');
  const [settingsOpen, setSettingsOpen] = useState<false | SectionId>(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const citationFocus = useCitationFocus();
  // Only the transcript the jump was made for may act on it: a switch to
  // another session during the highlight must not search it for a foreign id.
  const focusSegmentId = citationFocus.focus && citationFocus.focus.sessionId === activeId
    ? citationFocus.focus.segmentId : null;
  const clearCitationFocus = citationFocus.clear;
  const [citationError, setCitationError] = useState<string | null>(null);
  const panels = usePanelLayout();
  const floating: PanelId | null = panels.layout.sessions.overlay ? 'sessions'
    : panels.layout.assistant.overlay ? 'assistant' : null;

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
    const onOpen = (event: Event) => setSettingsOpen((event as CustomEvent<SectionId>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, []);

  // A citation jump belongs to the transcript it was made for: leaving that
  // transcript (another tab or session) drops it, so a return keeps the
  // reader's place instead of jumping back to an old citation.
  const citedSessionId = citationFocus.focus?.sessionId;
  useEffect(() => {
    if (tab !== 'transcript' || (citedSessionId !== undefined && citedSessionId !== activeId)) clearCitationFocus();
  }, [tab, activeId, citedSessionId, clearCitationFocus]);

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

  const onCite = async (citation: Citation) => {
    setCitationError(null);
    const target = citation.session_id;
    if (target && target !== useStore.getState().activeSessionId) {
      if (['recording', 'paused', 'processing'].includes(useStore.getState().recorderState)) {
        setCitationError('Stop recording to open a source from another session.');
        return;
      }
      await selectSession(target);
      if (useStore.getState().activeSessionId !== target || useStore.getState().detailError) {
        setCitationError('Could not open the source recording. It may have been deleted.');
        return;
      }
    }
    setTab('transcript');
    citationFocus.cite(citation.segment_id, useStore.getState().activeSessionId);
  };

  return (
    <div className="app">
      <header className="titlebar">
        <TitlebarLeading panels={panels} onOpenSettings={() => setSettingsOpen('system')} />
        <div className="titlebar__group titlebar__group--end">
          <BackendStatusDot />
          <TitlebarTrailing panels={panels} />
        </div>
      </header>

      {citationError && <p role="alert" className="assistant__error">{citationError}</p>}
      <main
        className={clsx('workspace', panels.dragging !== null && 'workspace--dragging')}
        style={{
          '--sessions-col': `${panels.layout.sessions.docked ? panels.layout.sessions.width : 0}px`,
          '--assistant-col': `${panels.layout.assistant.docked ? panels.layout.assistant.width : 0}px`,
          '--sessions-w': `${panels.layout.sessions.width}px`,
          '--assistant-w': `${panels.layout.assistant.width}px`,
        } as CSSProperties}
      >
        <PanelSlot id="sessions" view={panels.layout.sessions}>
          <SessionList onOpenSettings={() => setSettingsOpen('system')} onOpenSearch={() => setSearchOpen(true)} />
        </PanelSlot>

        <section className="center" data-pane="center" aria-label="Transcript and notes">
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
                onDeleted={() => { useStore.setState({ activeSessionId: null }); void useStore.getState().refreshImports(); void refreshSessions(); }}
              />
            ) : tab === 'transcript' ? (
              <TranscriptView key={activeId} focusSegmentId={focusSegmentId} />
            ) : (
              <NotesPanel onCite={onCite} />
            )}
          </div>
          <div className="center__footer">
            <ProactiveCards onCite={onCite} />
            <RecorderBar />
          </div>
        </section>

        <PanelSlot id="assistant" view={panels.layout.assistant}>
          <AssistantPanel onCite={onCite} onOpenSettings={() => setSettingsOpen('agent')} />
        </PanelSlot>
        <PanelResizer id="sessions" panels={panels} />
        <PanelResizer id="assistant" panels={panels} />
        {/* A floating panel is a screen of its own (PANES-SPEC §6): the centre
            under it is dimmed and inert, and a press on it puts the panel away.
            It stays "open" in the layout preference, so a wider window docks it
            again — it was hidden only because the window was too narrow. */}
        {floating && (
          <div
            className="workspace__scrim"
            aria-hidden="true"
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              panels.dismissOverlay();
            }}
          />
        )}
      </main>

      {settingsOpen && <SettingsPanel initialSection={settingsOpen} onClose={() => setSettingsOpen(false)} />}
      <WebSearchApproval />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onCite={onCite} />
      {!ready && <BackendGate />}
      {/* Only once the backend answered: the language list comes from it. */}
      {ready && settings && !settings.used_languages?.length && <LanguageOnboarding />}
    </div>
  );
}
