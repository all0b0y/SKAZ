import { createContext, useContext, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { BridgeApi } from '../../api/bridge';
import { KbClient } from '../api/client';
import { nativeCapture, type CaptureFactory } from '../recording/capture';
import { createRecordingStore, type RecordingActions, type RecordingData, type RecordingStore } from '../recording/recordingStore';
import { createAgentsStore, type AgentsActions, type AgentsData, type AgentsStore } from './agents';
import { createChatsStore, type ChatsActions, type ChatsData, type ChatsStore } from './chats';
import { createComposerBus, type ComposerBus, type ComposerBusState } from './composer';
import { createLibraryStore, type LibraryActions, type LibraryData, type LibraryStore } from './library';
import {
  createNotificationsStore, type NotificationsActions, type NotificationsData, type NotificationsStore,
} from './notifications';
import { createPrefsStore, type Prefs, type PrefsActions, type PrefsStore } from './prefs';
import { createSettingsStore, type SettingsActions, type SettingsData, type SettingsStore } from './settings';
import { createUiStore, type UiState, type UiStore } from './ui';

/** Bridge methods the new interface uses when the host has them (Electron); tests pass a subset. */
type OptionalBridge = 'chooseStorageRoot' | 'getBackendStatus' | 'onBackendStatus' | 'restartBackend' | 'onPrepareQuit'
  | 'dictate' | 'saveTextFile' | 'chooseMaterialFiles' | 'droppedMediaFile' | 'openLogsFolder' | 'openSystemAudioSettings'
  | 'openNative' | 'sendNativeAudio' | 'endNative' | 'onNativeFailure' | 'reportCaptureState'
  | 'chooseAudioFile' | 'systemAudioSupported' | 'mediaAccess' | 'chooseExportFolder' | 'showInFinder' | 'openInObsidian';

export type KbBridge = Pick<BridgeApi, 'request'> & Partial<Pick<BridgeApi, OptionalBridge>>;

export interface KbServices {
  bridge: KbBridge;
  client: KbClient;
  prefs: PrefsStore;
  library: LibraryStore;
  ui: UiStore;
  recording: RecordingStore;
  chats: ChatsStore;
  notifications: NotificationsStore;
  agents: AgentsStore;
  settings: SettingsStore;
  composer: ComposerBus;
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
  const ui = createUiStore();
  const chats = createChatsStore(client);
  const library = createLibraryStore(client, {
    onForget: (id, { keepPanel }) => {
      // Answers already on screen stop citing it as if it were there (QA D4/B9).
      chats.getState().forget({ material: id });
      if (keepPanel) return;
      const { right, closeDoc } = ui.getState();
      const shows = right?.kind === 'live' ? right.materialId === id
        : right?.kind === 'doc' && right.target.type === 'material' && right.target.id === id;
      if (shows) closeDoc();
    },
  });
  const recording = createRecordingStore({
    client, bridge, ui,
    capture: options.capture !== undefined ? options.capture : defaultCapture(bridge),
    onMaterialsChanged: () => { void library.getState().loadContent(); },
  });
  return {
    bridge,
    client,
    prefs: createPrefsStore(storage),
    library,
    ui,
    recording,
    chats,
    notifications: createNotificationsStore(client),
    agents: createAgentsStore(client),
    settings: createSettingsStore(client),
    composer: createComposerBus(),
  };
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

export function useChats<T>(selector: (state: ChatsData & ChatsActions) => T): T {
  return useStore(useServices().chats, selector);
}

export function useNotifications<T>(selector: (state: NotificationsData & NotificationsActions) => T): T {
  return useStore(useServices().notifications, selector);
}

export function useAgents<T>(selector: (state: AgentsData & AgentsActions) => T): T {
  return useStore(useServices().agents, selector);
}

export function useSettings<T>(selector: (state: SettingsData & SettingsActions) => T): T {
  return useStore(useServices().settings, selector);
}

export function useComposerBus<T>(selector: (state: ComposerBusState) => T): T {
  return useStore(useServices().composer, selector);
}
