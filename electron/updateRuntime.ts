// Wires the updater (updates.ts) to Electron: real fetch, files in the app cache, hdiutil/codesign,
// install.sh, a native notification, and the IPC the About row uses. Started by main.ts.

import { app, ipcMain, Notification, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CHANNELS } from './channels';
import { CHECK_EVERY_MS, Updater, installerLaunch, signatureCommands, updateChecksEnabled, type UpdaterStore } from './updates';

const run = promisify(execFile);
const FIRST_CHECK_DELAY_MS = 10_000;

async function writeStream(file: string, chunks: AsyncIterable<Uint8Array>, onBytes: (bytes: number) => void): Promise<number> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const part = `${file}.part`;
  const out = createWriteStream(part, { mode: 0o600 });
  let total = 0;
  try {
    for await (const chunk of chunks) {
      total += chunk.byteLength;
      onBytes(chunk.byteLength);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    renameSync(part, file);
    return total;
  } catch (error) {
    out.destroy();
    rmSync(part, { force: true });
    throw error;
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (d) => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifySignature(dmg: string): Promise<string | null> {
  if (process.platform !== 'darwin') return 'The signature can only be checked on macOS. Not installing.';
  const mount = mkdtempSync(path.join(os.tmpdir(), 'skaz-update-'));
  const [attach, verify] = signatureCommands(dmg, mount);
  let attached = false;
  try {
    await run(attach!.command, attach!.args, { timeout: 120_000 });
    attached = true;
    await run(verify!.command, verify!.args, { timeout: 120_000 });
    return null;
  } catch {
    return attached
      ? 'SKAZ.app in the download is not signed with SKAZ’s certificate. Not installing.'
      : 'The downloaded DMG couldn’t be opened. Not installing.';
  } finally {
    if (attached) await run('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { timeout: 60_000 }).catch(() => undefined);
    rmSync(mount, { recursive: true, force: true });
  }
}

/** The folder that holds the running SKAZ.app (…/SKAZ.app/Contents/MacOS/SKAZ → …). */
function installDir(): string {
  return path.resolve(app.getPath('exe'), '..', '..', '..', '..');
}

export function registerUpdates(window: () => BrowserWindow | null, trusted: (event: IpcMainInvokeEvent) => boolean): Updater {
  const userData = app.getPath('userData');
  const storeFile = path.join(userData, 'updates.json');
  const cache = path.join(app.getPath('home'), 'Library', 'Caches', 'SKAZ', 'updates');
  const updater = new Updater({
    version: app.getVersion(),
    packaged: app.isPackaged,
    enabled: updateChecksEnabled(process.env),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    load: () => {
      try { return JSON.parse(readFileSync(storeFile, 'utf8')) as UpdaterStore; } catch { return { etag: null, release: null, notified: null }; }
    },
    save: (store) => writeFileSync(storeFile, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 }),
    downloadDir: (version) => path.join(cache, version),
    writeFile: writeStream,
    readText: (file) => readFile(file, 'utf8'),
    sha256,
    verifySignature,
    runInstaller: async (version, folder) => {
      const script = path.join(process.resourcesPath, 'install.sh');
      if (!existsSync(script)) return false;
      const launch = installerLaunch({ script, version, folderUrl: pathToFileURL(folder).href, installDir: installDir(), home: app.getPath('home') });
      try {
        const log = openSync(path.join(app.getPath('logs'), 'update-install.log'), 'a', 0o600);
        // Detached: install.sh asks this SKAZ to quit, waits for it, copies the new SKAZ.app and opens it.
        spawn(launch.command, launch.args, { env: launch.env, detached: true, stdio: ['ignore', log, log] }).unref();
        return true;
      } catch {
        return false;
      }
    },
    quit: () => app.quit(),
    notify: (version) => {
      if (!Notification.isSupported()) return;
      const note = new Notification({ title: `SKAZ ${version} is available`, body: 'Open Settings → About to update.' });
      note.on('click', () => { const w = window(); if (w) { w.show(); w.focus(); } });
      note.show();
    },
    emit: (state) => {
      const w = window();
      if (w && !w.webContents.isDestroyed()) w.webContents.send(CHANNELS.updateState, state);
    },
  });

  ipcMain.handle(CHANNELS.updateGet, (event) => (trusted(event) ? updater.snapshot : null));
  ipcMain.handle(CHANNELS.updateCheck, (event) => (trusted(event) ? updater.check() : null));
  ipcMain.handle(CHANNELS.updatePrepare, (event) => (trusted(event) ? updater.prepare() : null));
  ipcMain.handle(CHANNELS.updateCancel, (event) => (trusted(event) ? updater.cancel() : null));
  ipcMain.handle(CHANNELS.updateInstall, (event) => (trusted(event) ? updater.install() : false));

  if (updateChecksEnabled(process.env)) {
    setTimeout(() => { void updater.check(); }, FIRST_CHECK_DELAY_MS).unref();
    setInterval(() => { void updater.check(); }, CHECK_EVERY_MS).unref();
  }
  return updater;
}
