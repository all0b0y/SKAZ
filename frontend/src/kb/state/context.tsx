import { createContext, useContext, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { BridgeApi } from '../../api/bridge';
import { KbClient } from '../api/client';
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

export type KbBridge = Pick<BridgeApi, 'request'> & Partial<Pick<BridgeApi,
  'chooseStorageRoot' | 'getBackendStatus' | 'onBackendStatus' | 'restartBackend' | 'onPrepareQuit'
  | 'dictate' | 'saveTextFile' | 'chooseMaterialFiles' | 'droppedMediaFile' | 'openLogsFolder'>>;

export interface KbServices {
  bridge: KbBridge;
  client: KbClient;
  prefs: PrefsStore;
  library: LibraryStore;
  ui: UiStore;
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

export function createServices(bridge: KbServices['bridge'], storage: Storage | null = safeStorage()): KbServices {
  const client = new KbClient(bridge);
  return {
    bridge,
    client,
    prefs: createPrefsStore(storage),
    library: createLibraryStore(client),
    ui: createUiStore(),
    chats: createChatsStore(client),
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
