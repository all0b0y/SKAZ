import { createContext, useContext, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { BridgeApi } from '../../api/bridge';
import { KbClient } from '../api/client';
import { KbU3Client, type BridgeB2 } from '../api/b2-u3';
import { nativeCapture, type CaptureFactory } from '../recording/capture';
import { createRecordingStore, type RecordingActions, type RecordingData, type RecordingStore } from '../recording/recordingStore';
import { createLibraryStore, type LibraryActions, type LibraryData, type LibraryStore } from './library';
import { createPrefsStore, type Prefs, type PrefsActions, type PrefsStore } from './prefs';
import { createUiStore, type UiState, type UiStore } from './ui';

type OptionalBridge = 'chooseStorageRoot' | 'getBackendStatus' | 'onBackendStatus' | 'restartBackend' | 'onPrepareQuit'
  | 'openNative' | 'sendNativeAudio' | 'endNative' | 'onNativeFailure' | 'reportCaptureState'
  | 'droppedMediaFile' | 'chooseAudioFile' | 'systemAudioSupported';

export interface KbServices {
  bridge: Pick<BridgeApi, 'request'> & Partial<Pick<BridgeApi, OptionalBridge>> & BridgeB2;
  client: KbClient;
  /** Package-2 routes of the U3 screens (see api/b2-u3.ts). */
  u3: KbU3Client;
  prefs: PrefsStore;
  library: LibraryStore;
  ui: UiStore;
  recording: RecordingStore;
}

const Ctx = createContext<KbServices | null>(null);

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The real capture pipeline when the bridge has the native audio methods (Electron), else none. */
function defaultCapture(bridge: KbServices['bridge']): CaptureFactory | null {
  const { openNative, sendNativeAudio, endNative, onNativeFailure } = bridge;
  if (!openNative || !sendNativeAudio || !endNative || !onNativeFailure) return null;
  return () => nativeCapture(bridge as Parameters<typeof nativeCapture>[0]);
}

export function createServices(
  bridge: KbServices['bridge'],
  storage: Storage | null = safeStorage(),
  options: { capture?: CaptureFactory | null } = {},
): KbServices {
  const client = new KbClient(bridge);
  const u3 = new KbU3Client(bridge);
  const ui = createUiStore();
  const library = createLibraryStore(client);
  const recording = createRecordingStore({
    u3, bridge, ui,
    capture: options.capture !== undefined ? options.capture : defaultCapture(bridge),
    onMaterialsChanged: () => { void library.getState().loadContent(); },
  });
  return { bridge, client, u3, prefs: createPrefsStore(storage), library, ui, recording };
}

/** Dependency root of the new interface: one client and one set of stores per app (or per test). */
export function KbServicesProvider({ services, bridge, children }: {
  services?: KbServices;
  bridge?: KbServices['bridge'];
  children: ReactNode;
}) {
  const [value] = useState<KbServices>(() => services ?? createServices(bridge ?? window.skaz));
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServices(): KbServices {
  const value = useContext(Ctx);
  if (!value) throw new Error('KbServicesProvider is missing');
  return value;
}

export function usePrefs<T>(selector: (state: Prefs & PrefsActions) => T): T {
  return useStore(useServices().prefs, selector);
}

export function useLibrary<T>(selector: (state: LibraryData & LibraryActions) => T): T {
  return useStore(useServices().library, selector);
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(useServices().ui, selector);
}

export function useRecording<T>(selector: (state: RecordingData & RecordingActions) => T): T {
  return useStore(useServices().recording, selector);
}
