import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackendStatus } from '../api/bridge';
import { LoadingTree } from '../brand/LoadingTree';
import { Banner, Button } from './ui';
import { MotionProvider } from './ui/motion';
import { KbServicesProvider, useLibrary, usePrefs, useServices, useUi, type KbServices } from './state/context';
import { Shell } from './shell/Shell';
import { useProblems } from './shell/problems';
import type { SettingsSection } from './state/ui';
import { SettingsModal } from './settings/SettingsModal';
import { LibrarySetupModal, Onboarding } from './onboarding/Onboarding';
import { CommandK } from './search/CommandK';
import { DecisionModal } from './notifications/DecisionModal';
import { SelectionToolbar } from './ui/Selection';
import { AddMaterialModal } from './materials/AddMaterialModal';

/** Mirror theme and text size onto <html>, where the tokens read them. */
function ThemeSync() {
  const theme = usePrefs((s) => s.theme);
  const textSize = usePrefs((s) => s.textSize);
  useEffect(() => {
    const html = document.documentElement;
    html.dataset.kbUi = '';
    if (theme === 'system') delete html.dataset.theme;
    else html.dataset.theme = theme;
    html.dataset.textSize = textSize;
  }, [theme, textSize]);
  return null;
}

/** How long the startup screen stays over the ready app while it fades out (its CSS is 0.42 s). */
const GATE_FADE_MS = 450;

/**
 * The local service starts with the window; wait for it honestly, show its own error otherwise.
 * The startup screen is the tree (LoadingTree); the app mounts the moment the service is ready
 * and the tree fades out over it.
 */
function BackendGate({ children }: { children: ReactNode }) {
  const { bridge } = useServices();
  const [status, setStatus] = useState<BackendStatus | null>(bridge.getBackendStatus ? null : { phase: 'ready' });
  /** Bumped on every new start after a failure, so the animation begins from its first frame. */
  const [attempt, setAttempt] = useState(0);
  /** The startup screen has finished fading out over the app. */
  const [gone, setGone] = useState(status?.phase === 'ready');
  const phase = status?.phase ?? 'starting';
  const failed = phase === 'error' || phase === 'stopped';
  const previous = useRef(phase);
  /** The service was up in this window once: a later failure is a stop, not a failed start (QA A16). */
  const wasReady = useRef(phase === 'ready');
  if (phase === 'ready') wasReady.current = true;
  useEffect(() => {
    if (!bridge.getBackendStatus) return undefined;
    let live = true;
    // An event is newer than the first answer if it comes first: the answer must not undo it.
    let heard = false;
    void bridge.getBackendStatus().then((s) => { if (live && !heard) setStatus(s); });
    const off = bridge.onBackendStatus?.((s) => { heard = true; setStatus(s); });
    return () => { live = false; off?.(); };
  }, [bridge]);
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (phase === 'starting' && (before === 'error' || before === 'stopped')) setAttempt((n) => n + 1);
    if (phase !== 'ready') {
      setGone(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setGone(true), GATE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const retry = () => {
    wasReady.current = false; // a failure after Try again is a failed start again
    setStatus({ phase: 'starting' });
    void bridge.restartBackend?.().then((restarted) => {
      // Nothing to retry (the start had not failed after all): show where it really is.
      if (!restarted) void bridge.getBackendStatus?.().then(setStatus);
    });
  };
  return (
    <>
      {phase === 'ready' ? children : null}
      {phase === 'ready' && gone ? null : (
        <LoadingTree phase={failed ? 'error' : phase === 'ready' ? 'ready' : 'starting'} attempt={attempt}>
          <Banner tone="error" title={wasReady.current || status?.stopped ? 'SKAZ’s local service stopped.' : 'SKAZ couldn’t start its local service.'}
            actions={bridge.restartBackend || bridge.openLogsFolder ? (
              <>
                {bridge.restartBackend && <Button variant="fill" icon="retry" onClick={retry}>Try again</Button>}
                {bridge.openLogsFolder && <Button icon="folder" onClick={() => void bridge.openLogsFolder?.()}>Open logs folder</Button>}
              </>
            ) : undefined}>
            {wasReady.current || status?.stopped ? 'Your materials, wiki and chats are safe on disk. Try again starts it again.' : status?.detail ?? ''}
          </Banner>
        </LoadingTree>
      )}
    </>
  );
}

/**
 * Quit barrier: main asks the renderer to save before closing and waits for an answer. Without a
 * recording there is nothing unsaved and the answer is immediate; a running or paused recording
 * is stopped first and the answer says whether its audio reached local storage (false = main
 * keeps warning instead of losing audio). Chat answers live in the backend (it ends them itself
 * on shutdown — 409 CLOSING), so they hold nothing unsaved in this window.
 */
function useQuitAnswer() {
  const { bridge, recording } = useServices();
  useEffect(() => bridge.onPrepareQuit?.(() => recording.getState().prepareQuit()), [bridge, recording]);
}

function useSettingsShortcut() {
  const { prefs } = useServices();
  // ⌘, opens where the gear would: the section with the most urgent problem (QA A33).
  const problems = useProblems();
  const target = useRef<SettingsSection | undefined>(undefined);
  target.current = problems[0]?.section;
  const openSettings = useUi((s) => s.openSettings);
  const setSearchOpen = useUi((s) => s.setSearchOpen);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      // First launch can't be dismissed: nothing opens over or instead of it (QA A32).
      if (!prefs.getState().onboardingDone) return;
      if (event.key === ',') {
        event.preventDefault();
        openSettings(target.current);
      } else if (event.key.toLowerCase() === 'k') {
        // ⌘K (decision 29): opens over whatever is open; a second ⌘K closes it.
        event.preventDefault();
        setSearchOpen(!document.querySelector('[data-testid="search"]'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSettings, setSearchOpen, prefs]);
}

/**
 * Live data of the window: chats (list + answering/new-answer marks) and the notification feed
 * follow the backend by long poll while the library is connected; agents and settings health are
 * read once at start (and again by the screens that change them); agents are also re-checked when
 * the window regains focus.
 */
function useLiveData() {
  const { chats, notifications, agents, settings } = useServices();
  const ready = useLibrary((s) => s.library?.state === 'ready');
  useEffect(() => {
    void agents.getState().refresh();
    const s = settings.getState();
    void s.loadHealth();
    void s.loadWiki();
    void s.loadSpeech();
  }, [agents, settings]);
  // Agents are checked again when the window comes back (throttled per agent in the store;
  // nothing runs while the window is hidden — there is no timer, only this event).
  useEffect(() => {
    const onFocus = () => agents.getState().autoCheck('focus');
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [agents]);
  useEffect(() => {
    if (!ready) return undefined;
    void chats.getState().loadList();
    void notifications.getState().refresh();
    const stopList = chats.getState().startListPoll();
    const stopFeed = notifications.getState().start();
    return () => { stopList(); stopFeed(); };
  }, [ready, chats, notifications]);
}

function Workspace() {
  const { library, prefs } = useServices();
  const onboardingDone = usePrefs((s) => s.onboardingDone);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const librarySetupOpen = useUi((s) => s.librarySetupOpen);
  const setLibrarySetupOpen = useUi((s) => s.setLibrarySetupOpen);
  useSettingsShortcut();
  useLiveData();
  useEffect(() => { void library.getState().loadLibrary(); }, [library]);
  return (
    <>
      <Shell />
      <SettingsModal />
      <CommandK />
      <DecisionModal />
      <SelectionToolbar />
      <Onboarding open={!onboardingDone && !settingsOpen} onFinish={() => prefs.getState().set({ onboardingDone: true })} />
      <LibrarySetupModal open={librarySetupOpen && onboardingDone} onClose={() => setLibrarySetupOpen(false)} />
      <AddMaterialModal />
    </>
  );
}

function QuitAnswer() {
  useQuitAnswer();
  return null;
}

/** Entry of the interface (Knowledge Wiki), mounted by main.tsx. */
export function KbApp({ services }: { services?: KbServices }) {
  return (
    <KbServicesProvider services={services}>
      <MotionProvider>
        <QuitAnswer />
        <ThemeSync />
        <BackendGate>
          <Workspace />
        </BackendGate>
      </MotionProvider>
    </KbServicesProvider>
  );
}
