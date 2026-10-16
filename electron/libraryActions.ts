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

// ---- Open in Obsidian ---------------------------------------------------------------------------
//
// `obsidian://open?path=` only opens a path inside a vault Obsidian already knows; for any other
// folder it shows "Vault not found". Obsidian keeps its vault list in
// ~/Library/Application Support/obsidian/obsidian.json, reads it once at launch and writes it back
// while running. So the library becomes a vault by adding it to that list — only while Obsidian is
// closed (an edit made while it runs would be overwritten). When Obsidian is open and doesn't know
// the library, the user is asked first; with their yes SKAZ quits Obsidian, adds the vault and opens it.

export type ObsidianResult =
  | { ok: true }
  | { ok: false; reason: 'not_installed' | 'unavailable' | 'obsidian_running' | 'obsidian_config' };

/** The fixed Obsidian URL for an absolute path (the library root as a vault, or one page). */
export function obsidianUrl(absolutePath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absolutePath)}`;
}

export interface ObsidianDeps {
  /** /Applications/Obsidian.app, ~/Applications/Obsidian.app, or a handler of obsidian:// in Launch Services. */
  installed: () => boolean;
  openExternal: (url: string) => Promise<void>;
  /** Obsidian's own obsidian.json (vault list); read → null when there is none yet. */
  vaultList: { read: () => string | null; write: (text: string) => void };
  /** Obsidian's main process is running. */
  running: () => boolean;
  /** Ask Obsidian to quit and wait until it has; false when it is still running. */
  quit: () => Promise<boolean>;
  now: () => number;
  /** A new vault id: 16 lowercase hex characters, as Obsidian makes them. */
  newVaultId: () => string;
}

/** Obsidian is installed where macOS keeps apps, or registered for obsidian:// links. */
export function obsidianInstalled(home: string, exists: (p: string) => boolean, protocolHandler: () => string): boolean {
  if (exists('/Applications/Obsidian.app') || exists(path.join(home, 'Applications', 'Obsidian.app'))) return true;
  try {
    return protocolHandler().trim() !== '';
  } catch {
    return false;
  }
}

type VaultConfig = { vaults?: Record<string, { path?: unknown }> } & Record<string, unknown>;

/** Obsidian's config, or null when the file is there but isn't the JSON object it should be. */
function readVaults(deps: ObsidianDeps): VaultConfig | null {
  let text: string | null;
  try { text = deps.vaultList.read(); } catch { return null; }
  if (text === null || text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const vaults = (parsed as VaultConfig).vaults;
    if (vaults !== undefined && (!vaults || typeof vaults !== 'object' || Array.isArray(vaults))) return null;
    return parsed as VaultConfig;
  } catch {
    return null;
  }
}

/** Some known vault holds `folder` (is it, or a folder around it) — Obsidian's own rule for open?path=. */
export function vaultHolds(config: VaultConfig, folder: string): boolean {
  return Object.values(config.vaults ?? {}).some(
    (vault) => typeof vault?.path === 'string' && path.isAbsolute(vault.path) && isInside(path.resolve(vault.path), folder),
  );
}

/** Add the library as a vault to Obsidian's list (Obsidian must not be running). */
function addVault(deps: ObsidianDeps, root: string): boolean {
  const config = readVaults(deps);
  if (!config) return false;
  if (vaultHolds(config, root)) return true;
  const vaults = { ...(config.vaults ?? {}) };
  let id = deps.newVaultId();
  while (Object.hasOwn(vaults, id)) id = deps.newVaultId();
  vaults[id] = { path: root, ts: deps.now() } as { path: string };
  try {
    deps.vaultList.write(JSON.stringify({ ...config, vaults }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the library or a page in Obsidian; the URL is built here from a checked path, never taken
 * from the renderer. `restart` is the user's yes to "quit Obsidian so SKAZ can add the library".
 */
export async function openInObsidian(
  target: unknown, deps: LibraryActionDeps & ObsidianDeps, exports: ExportFolders, options: { restart?: unknown } = {},
): Promise<ObsidianResult> {
  const kind = (target as { kind?: unknown } | null)?.kind;
  if (kind !== 'library' && kind !== 'page') return { ok: false, reason: 'unavailable' };
  if (!deps.installed()) return { ok: false, reason: 'not_installed' };
  const resolved = await resolveTarget(target, deps, exports);
  const root = resolved ? await libraryRoot(deps) : null;
  if (!resolved || !root) return { ok: false, reason: 'unavailable' };
  const config = readVaults(deps);
  if (!config) return { ok: false, reason: 'obsidian_config' };
  if (!vaultHolds(config, root)) {
    if (deps.running()) {
      if (options.restart !== true) return { ok: false, reason: 'obsidian_running' };
      if (!(await deps.quit())) return { ok: false, reason: 'obsidian_running' };
    }
    if (!addVault(deps, root)) return { ok: false, reason: 'obsidian_config' };
  }
  try {
    await deps.openExternal(obsidianUrl(resolved.path));
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
