// Main-process side of the library's file actions (decision B20): the export folder chooser,
// "Show in Finder" and "Open in Obsidian". Electron-free (dependencies injected), so the rules are
// unit-tested; ipc.ts wires the real dialog/shell/fs/fetch.
//
// The renderer never passes a URL or an arbitrary path to open: it names a target —
//  - `{ kind: 'library' }`        the library root, as the backend reports it (GET /kb/library);
//  - `{ kind: 'page', id }`       a wiki page, whose file main asks the backend for and checks it
//                                 lies inside the library root;
//  - `{ kind: 'export', path }`   a folder the user picked in SKAZ's own export chooser (kept in a
//                                 small allow-list file in the profile), nothing else.

import path from 'node:path';
export type { RevealTarget } from '../frontend/src/api/bridge';

export interface LibraryActionDeps {
  /** GET a backend JSON route with this run's token; null when it failed or the backend isn't ready. */
  getJson: (route: string) => Promise<unknown>;
  /** Real path (symlinks resolved) or null when nothing is there. */
  realPath: (p: string) => string | null;
  isDirectory: (p: string) => boolean;
  isFile: (p: string) => boolean;
}

const MAX_EXPORT_FOLDERS = 20;
const PAGE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Folders chosen in SKAZ's export chooser: the only export paths "Show in Finder" opens. */
export class ExportFolders {
  private folders: string[];

  constructor(private readonly store: { read: () => string | null; write: (text: string) => void }) {
    this.folders = [];
    try {
      const parsed = JSON.parse(store.read() ?? '[]') as unknown;
      if (Array.isArray(parsed)) this.folders = parsed.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p));
    } catch {
      this.folders = [];
    }
  }

  remember(folder: string): void {
    if (!path.isAbsolute(folder)) return;
    const normal = path.resolve(folder);
    this.folders = [normal, ...this.folders.filter((p) => p !== normal)].slice(0, MAX_EXPORT_FOLDERS);
    try { this.store.write(JSON.stringify(this.folders)); } catch { /* the list only lives for this run */ }
  }

  has(folder: string): boolean {
    return path.isAbsolute(folder) && this.folders.includes(path.resolve(folder));
  }
}

/** `child` is `root` itself or inside it (both already real paths). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function libraryRoot(deps: LibraryActionDeps): Promise<string | null> {
  const library = await deps.getJson('/kb/library') as { state?: unknown; root?: unknown } | null;
  if (!library || library.state !== 'ready' || typeof library.root !== 'string' || !path.isAbsolute(library.root)) return null;
  const real = deps.realPath(library.root);
  return real && deps.isDirectory(real) ? real : null;
}

/** The path a target stands for, checked; null when it isn't allowed or isn't there. */
export async function resolveTarget(target: unknown, deps: LibraryActionDeps, exports: ExportFolders): Promise<
  { path: string; directory: boolean } | null
> {
  if (!target || typeof target !== 'object') return null;
  const t = target as Partial<{ kind: string; id: unknown; path: unknown }>;
  if (t.kind === 'library') {
    const root = await libraryRoot(deps);
    return root ? { path: root, directory: true } : null;
  }
  if (t.kind === 'page') {
    if (typeof t.id !== 'string' || !PAGE_ID.test(t.id)) return null;
    const root = await libraryRoot(deps);
    if (!root) return null;
    const file = await deps.getJson(`/kb/wiki/pages/${t.id}/file`) as { path?: unknown } | null;
    if (!file || typeof file.path !== 'string' || !path.isAbsolute(file.path)) return null;
    const real = deps.realPath(file.path);
    if (!real || !isInside(root, real) || !deps.isFile(real) || !real.toLowerCase().endsWith('.md')) return null;
    return { path: real, directory: false };
  }
  if (t.kind === 'export') {
    if (typeof t.path !== 'string' || !exports.has(t.path)) return null;
    const real = deps.realPath(t.path);
    return real && deps.isDirectory(real) ? { path: real, directory: true } : null;
  }
  return null;
}
