// What closing the window means (decision 3f′), free of Electron imports so it can be unit-tested. By default
// the window only hides and SKAZ stays in the tray; the setting "Closing the window quits SKAZ" restores the
// full quit. Quitting itself (Quit in the tray menu, Cmd+Q) stays the quit controller's business, which asks
// this class only after its own shutdown checks, so a quit in progress can never be turned into a hide.

import { mkdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface TrayPrefs {
  /** The setting: closing the window is a full quit. */
  closeQuits: boolean;
  /** The one-time first-close hint has been shown. */
  hintShown: boolean;
}

export interface TrayPrefsStore {
  read(): TrayPrefs;
  /** False when it could not be saved. */
  write(prefs: TrayPrefs): boolean;
}

export interface TrayBehaviorDeps {
  prefs: TrayPrefsStore;
  /** False when no tray icon exists: hiding then would leave SKAZ running with no way back. */
  trayAvailable: () => boolean;
  hide: () => void;
  /** Show the first-close hint. False when this system can't show one, so a later close tries again. */
  showHint: () => boolean;
}

export class TrayBehavior {
  private prefs: TrayPrefs;
  private sessionEnding = false;

  constructor(private readonly deps: TrayBehaviorDeps) {
    this.prefs = deps.prefs.read();
  }

  get closeQuits(): boolean {
    return this.prefs.closeQuits;
  }

  /** Change the setting and persist it. Returns the state really in force: unsaved means unchanged. */
  setCloseQuits(on: boolean): boolean {
    if (on === this.prefs.closeQuits) return on;
    const next = { ...this.prefs, closeQuits: on };
    if (this.deps.prefs.write(next)) this.prefs = next;
    return this.prefs.closeQuits;
  }

  /** The OS is ending the session. On Windows no before-quit comes then: the close is the only way out. */
  onSessionEnd(): void {
    this.sessionEnding = true;
  }

  /** Returns true when the close was taken: the window hides and SKAZ stays in the tray. */
  onWindowClose(): boolean {
    if (this.prefs.closeQuits || this.sessionEnding || !this.deps.trayAvailable()) return false;
    this.deps.hide();
    this.offerHint();
    return true;
  }

  private offerHint(): void {
    if (this.prefs.hintShown) return;
    let shown = false;
    try {
      shown = this.deps.showHint();
    } catch (err) {
      console.error('[tray] first-close hint failed:', err instanceof Error ? err.message : err);
    }
    if (!shown) return;
    this.prefs = { ...this.prefs, hintShown: true };
    this.deps.prefs.write(this.prefs); // unsaved: the hint comes once more next launch, nothing worse
  }
}

const PREF_FILE = 'tray.json';

export function readTrayPrefs(userDataDir: string): TrayPrefs {
  try {
    const raw = JSON.parse(readFileSync(path.join(userDataDir, PREF_FILE), 'utf8')) as Partial<Record<keyof TrayPrefs, unknown>> | null;
    return { closeQuits: raw?.closeQuits === true, hintShown: raw?.hintShown === true };
  } catch {
    return { closeQuits: false, hintShown: false };
  }
}

export function writeTrayPrefs(userDataDir: string, prefs: TrayPrefs): boolean {
  const file = path.join(userDataDir, PREF_FILE);
  const part = `${file}.part`;
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(part, JSON.stringify(prefs));
    renameSync(part, file); // a crash mid-write must not lose the setting
    return true;
  } catch {
    return false;
  }
}

export function trayPrefsStore(userDataDir: string): TrayPrefsStore {
  return {
    read: () => readTrayPrefs(userDataDir),
    write: (prefs) => writeTrayPrefs(userDataDir, prefs),
  };
}

export type TrayMenuItem =
  | { label: string; click: () => void }
  | { label: string; enabled: false }
  | { type: 'separator' };

/** Open SKAZ · what SKAZ is doing (a line to read, not a button) · Quit. */
export function trayMenuTemplate(status: string, actions: { open: () => void; quit: () => void }): TrayMenuItem[] {
  return [
    { label: 'Open SKAZ', click: () => actions.open() },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => actions.quit() },
  ];
}

export function firstCloseHint(platform: NodeJS.Platform): { title: string; body: string } {
  const place = platform === 'darwin' ? 'menu bar' : 'tray';
  return {
    title: `SKAZ is still running in the ${place}`,
    body: `Open or quit it from its icon in the ${place}.`,
  };
}
