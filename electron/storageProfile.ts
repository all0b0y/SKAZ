import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface StorageProfile {
  name: 'default' | 'dev' | 'test';
  userData: string;
  documents: string;
}

export function resolveStorageProfile(facts: {
  home: string; documents: string; packaged: boolean; requested?: string;
}): StorageProfile {
  const name = facts.packaged ? 'default' : facts.requested ?? 'dev';
  if (name !== 'default' && name !== 'dev' && name !== 'test'
      || !facts.packaged && name === 'default') {
    throw new Error('Development profile must be dev or test.');
  }
  return {
    name,
    userData: path.join(facts.home, '.skaz', name),
    // Backend appends SKAZ to this parent. Keep the normal library location.
    documents: name === 'default' ? facts.documents : path.join(facts.documents, `SKAZ-${name}`),
  };
}

function assertStopped(source: string): void {
  const lock = path.join(source, 'SingletonLock');
  try {
    const target = readlinkSync(lock);
    const pid = Number(target.slice(target.lastIndexOf('-') + 1));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Unknown previous SKAZ lock.');
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    throw new Error('Quit the previous SKAZ installation before migrating its data.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Historical names are intentionally limited to migration. Never merge profiles. */
export function migrateLegacyProfile(home: string, target: string): void {
  if (existsSync(target)) return;
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const guard = path.join(parent, '.migration-lock');
  mkdirSync(guard, { mode: 0o700 });
  try {
    if (existsSync(target)) return;
    const sources = [
      { directory: path.join(home, 'Library/Application Support/skaz'), electron: true },
      { directory: path.join(home, 'Library/Application Support/AudioHelper'), electron: true },
      { directory: path.join(home, 'Library/Application Support/audiohelper'), electron: true },
      { directory: path.join(home, '.skaz'), electron: false },
      { directory: path.join(home, '.audiohelper'), electron: false },
    ];
    const hasDatabase = (directory: string): boolean =>
      ['skaz.sqlite3', 'audiohelper.sqlite3'].some((name) => existsSync(path.join(directory, name)));
    const source = sources.find(({ directory, electron }) =>
      hasDatabase(electron ? path.join(directory, 'data') : directory) || hasDatabase(directory));
    if (!source) return;
    if (lstatSync(source.directory).isSymbolicLink()) throw new Error('Legacy profile is a symlink.');
    assertStopped(source.directory);
    // A standalone backend has no Electron singleton lock. Do not copy/rename
    // a live SQLite/WAL set; old app versions do not share the new profile lock.
    if (process.platform === 'darwin') {
      const databases = ['', 'data'].flatMap((subdir) => ['skaz.sqlite3', 'audiohelper.sqlite3']
        .flatMap((name) => ['', '-wal', '-shm'].map((suffix) => path.join(source.directory, subdir, name + suffix))))
        .filter((file) => existsSync(file));
      try {
        if (execFileSync('/usr/sbin/lsof', ['-t', '--', ...databases], { encoding: 'utf8', timeout: 10_000 }).trim()) {
          throw new Error('Quit the previous SKAZ backend before migrating its database.');
        }
      } catch (error) {
        if ((error as { status?: number }).status !== 1) throw error;
      }
    }
    if (source.electron && hasDatabase(path.join(source.directory, 'data'))) {
      // Same home volume: rename the whole profile atomically, WAL and auth included.
      renameSync(source.directory, target);
    } else {
      // Older backend-only layouts need a data/ wrapper. Retain the source until
      // the staged copy is published; failed copies never appear as a fresh profile.
      const staging = path.join(guard, 'profile');
      const data = path.join(staging, 'data');
      mkdirSync(data, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(source.directory)) {
        if (source.directory === parent && ['default', 'dev', 'test', '.migration-lock'].includes(name)) continue;
        cpSync(path.join(source.directory, name), path.join(data, name), {
          recursive: true, errorOnExist: true, force: false, dereference: false,
        });
      }
      renameSync(staging, target);
    }
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}
