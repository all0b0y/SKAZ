// The real host for "Open in Obsidian" (libraryActions.openInObsidian): Obsidian's vault list file,
// whether Obsidian runs, and quitting it on the user's yes. Fixed paths and argv only — nothing
// from the renderer reaches a command line.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { obsidianInstalled, type ObsidianDeps } from './libraryActions';

const QUIT_WAIT_MS = 10_000;

function vaultListPath(): string {
  return path.join(app.getPath('appData'), 'obsidian', 'obsidian.json');
}

function running(): boolean {
  try {
    execFileSync('/usr/bin/pgrep', ['-x', 'Obsidian'], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

async function quit(): Promise<boolean> {
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application id "md.obsidian" to quit'], { stdio: 'ignore', timeout: QUIT_WAIT_MS });
  } catch {
    /* checked below */
  }
  const until = Date.now() + QUIT_WAIT_MS;
  while (Date.now() < until) {
    if (!running()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !running();
}

export function obsidianDeps(): ObsidianDeps {
  return {
    installed: () => obsidianInstalled(app.getPath('home'), existsSync, () => app.getApplicationNameForProtocol('obsidian://')),
    openExternal: (url) => shell.openExternal(url),
    vaultList: {
      read: () => (existsSync(vaultListPath()) ? readFileSync(vaultListPath(), 'utf8') : null),
      write: (text) => {
        const file = vaultListPath();
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.skaz-${process.pid}.tmp`;
        writeFileSync(temp, text, 'utf8');
        renameSync(temp, file);
      },
    },
    running,
    quit,
    now: () => Date.now(),
    newVaultId: () => randomBytes(8).toString('hex'),
  };
}
