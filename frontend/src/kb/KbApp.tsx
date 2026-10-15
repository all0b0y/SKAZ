import { useEffect, useState, type ReactNode } from 'react';
import type { BackendStatus } from '../api/bridge';
import { Banner, Button, Spinner } from './ui';
import { MotionProvider } from './ui/motion';
import { KbServicesProvider, usePrefs, useServices, useUi, type KbServices } from './state/context';
import { Shell } from './shell/Shell';
import { SettingsModal } from './settings/SettingsModal';
import { LibrarySetupModal, Onboarding } from './onboarding/Onboarding';
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

/** The local service starts with the window; wait for it honestly, show its own error otherwise. */
function BackendGate({ children }: { children: ReactNode }) {
  const { bridge } = useServices();
  const [status, setStatus] = useState<BackendStatus | null>(bridge.getBackendStatus ? null : { phase: 'ready' });
  useEffect(() => {
    if (!bridge.getBackendStatus) return undefined;
    let live = true;
    void bridge.getBackendStatus().then((s) => { if (live) setStatus(s); });
    const off = bridge.onBackendStatus?.((s) => setStatus(s));
    return () => { live = false; off?.(); };
  }, [bridge]);
  if (status?.phase === 'ready') return <>{children}</>;
  return (
    <div className="kb-gate" data-testid="backend-gate">
      {status?.phase === 'error' || status?.phase === 'stopped' ? (
        <div className="kb-gate__box">
          <Banner tone="error" title="SKAZ couldn’t start its local service."
            actions={bridge.restartBackend ? <Button variant="fill" icon="retry" onClick={() => void bridge.restartBackend?.()}>Try again</Button> : undefined}>
            {status.detail ?? ''}
          </Banner>
        </div>
      ) : (
        <Spinner label="Starting SKAZ" />
      )}
    </div>
  );
}

/**
 * Quit barrier: main asks the renderer to save before closing and waits for an answer. Without a
 * recording there is nothing unsaved and the answer is immediate; a running or paused recording
 * is stopped first and the answer says whether its audio reached local storage (false = main
 * keeps warning instead of losing audio).
 */
function useQuitAnswer() {
  const { bridge, recording } = useServices();
  useEffect(() => bridge.onPrepareQuit?.(() => recording.getState().prepareQuit()), [bridge, recording]);
}

function useSettingsShortcut() {
  const openSettings = useUi((s) => s.openSettings);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ',') {
        event.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSettings]);
}

function Workspace() {
  const { library, prefs } = useServices();
  const onboardingDone = usePrefs((s) => s.onboardingDone);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const librarySetupOpen = useUi((s) => s.librarySetupOpen);
  const setLibrarySetupOpen = useUi((s) => s.setLibrarySetupOpen);
  useSettingsShortcut();
  useEffect(() => { void library.getState().loadLibrary(); }, [library]);
  return (
    <>
      <Shell />
      <SettingsModal />
      <Onboarding open={!onboardingDone && !settingsOpen} onFinish={() => prefs.getState().set({ onboardingDone: true })} />
      <LibrarySetupModal open={librarySetupOpen && onboardingDone} onClose={() => setLibrarySetupOpen(false)} />
      <AddMaterialModal />
    </>
  );
}

/** Entry of the new interface (Knowledge Wiki). Chosen in main.tsx by VITE_SKAZ_UI / localStorage. */
function QuitAnswer() {
  useQuitAnswer();
  return null;
}

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
