// SKAZ must live in exactly one place. A copy launched straight from the
// mounted DMG (or from Downloads) is registered by macOS as a second SKAZ, so
// Launchpad and Spotlight show two identical icons. On first launch outside
// /Applications we offer to move the running app there; macOS then knows a
// single SKAZ. The decision is pure so it can be tested without Electron.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface InstallLocationFacts {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isInApplicationsFolder: boolean;
  /** The user ticked "Don't ask again" on an earlier launch. */
  declinedForever: boolean;
  /** Launched with an explicit --user-data-dir (smoke tests, release checks). */
  customUserData: boolean;
}

export function shouldOfferMoveToApplications(facts: InstallLocationFacts): boolean {
  return facts.platform === 'darwin'
    && facts.isPackaged
    && !facts.isInApplicationsFolder
    && !facts.declinedForever
    && !facts.customUserData;
}

const PREF_FILE = 'install-location.json';

export function readDeclinedForever(userDataDir: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path.join(userDataDir, PREF_FILE), 'utf8')) as unknown;
    return typeof raw === 'object' && raw !== null && (raw as { declined?: unknown }).declined === true;
  } catch {
    return false;
  }
}

export function writeDeclinedForever(userDataDir: string): void {
  try {
    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
    writeFileSync(path.join(userDataDir, PREF_FILE), JSON.stringify({ declined: true }));
  } catch {
    // Not worth failing startup over: the offer simply appears again next time.
  }
}
