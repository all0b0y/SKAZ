import { createContext, useContext, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { BridgeApi } from '../../api/bridge';
import { KbClient } from '../api/client';
import { createLibraryStore, type LibraryActions, type LibraryData, type LibraryStore } from './library';
import { createPrefsStore, type Prefs, type PrefsActions, type PrefsStore } from './prefs';
import { createUiStore, type UiState, type UiStore } from './ui';

export interface KbServices {
  bridge: Pick<BridgeApi, 'request'> & Partial<Pick<BridgeApi, 'chooseStorageRoot' | 'getBackendStatus' | 'onBackendStatus' | 'restartBackend' | 'onPrepareQuit'>>;
  client: KbClient;
  prefs: PrefsStore;
  library: LibraryStore;
  ui: UiStore;
}

const Ctx = createContext<KbServices | null>(null);

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function createServices(bridge: KbServices['bridge'], storage: Storage | null = safeStorage()): KbServices {
  const client = new KbClient(bridge);
  return { bridge, client, prefs: createPrefsStore(storage), library: createLibraryStore(client), ui: createUiStore() };
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
