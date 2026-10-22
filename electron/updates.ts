// Updates (decision B20), main process. Electron-free: every outside effect is injected, so the
// rules are unit-tested without a network; main.ts wires the real fetch, files and processes.
//
//  - Check: GET https://api.github.com/repos/all0b0y/SKAZ/releases/latest at start and every 24 h,
//    no token, with the last ETag (304 = nothing new). Offline or any failure is a silent
//    "Couldn't check" — never a notification, never a retry storm.
//  - Compare the release's version with app.getVersion() (semver); one notification per new version.
//  - Update (installed app only): download the release's DMG and SHA256SUMS.txt into the app cache
//    with progress, verify the size, the SHA-256 (SHA256SUMS.txt, and the asset digest when GitHub
//    lists one) and the code signature (codesign against SKAZ's certificate), then — after the user
//    agreed that SKAZ closes — run the same install.sh as the one-line installer on the downloaded
//    folder and quit; install.sh copies SKAZ.app into place and opens it again.
//  - Every URL is checked against a fixed allow-list, redirects included.

import type { UpdateState } from '../frontend/src/api/bridge';

export type { UpdatePhase, UpdateState } from '../frontend/src/api/bridge';

export const RELEASES_URL = 'https://api.github.com/repos/all0b0y/SKAZ/releases/latest';
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** The «SKAZ» code-signing certificate (SHA-1), the same pin as install.sh. */
export const CERT_SHA1 = '9aaf0dac082309848f22aebfdbc43efcba45b13e';
export const SUMS_NAME = 'SHA256SUMS.txt';
const MAX_REDIRECTS = 5;
/** A download that receives nothing for this long is stopped (M2: it used to hang for good). */
const STALL_MS = 60_000;
const CANCELLED = 'cancelled';
const MAX_DMG_BYTES = 2 * 1024 ** 3;
const MAX_SUMS_BYTES = 64 * 1024;

// ---- versions --------------------------------------------------------------------------------

interface Semver { major: number; minor: number; patch: number; pre: string[] }

export function parseVersion(raw: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] };
}

/** -1, 0 or 1 as semver orders `a` and `b`; null when either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---- release JSON ----------------------------------------------------------------------------

export interface ReleaseAsset { name: string; url: string; size: number; sha256: string | null }

export interface Release {
  version: string;
  tag: string;
  /** The release page (https://github.com/all0b0y/SKAZ/releases/tag/…). */
  page: string;
  dmg: ReleaseAsset;
  sums: ReleaseAsset | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

function asset(raw: unknown): ReleaseAsset | null {
  const a = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown } | null;
  if (!a || typeof a.name !== 'string' || typeof a.browser_download_url !== 'string' || typeof a.size !== 'number') return null;
  if (!isAllowedUpdateUrl(a.browser_download_url, 'download')) return null;
  const digest = typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : null;
  return { name: a.name, url: a.browser_download_url, size: a.size, sha256: digest && HEX64.test(digest) ? digest : null };
}

/** The release SKAZ can install, from the GitHub API answer; null for anything else. */
export function parseRelease(json: unknown): Release | null {
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null;
  if (!r || typeof r.tag_name !== 'string' || r.draft === true || r.prerelease === true || !Array.isArray(r.assets)) return null;
  const version = r.tag_name.replace(/^v/, '');
  if (!parseVersion(version)) return null;
  const assets = r.assets.map(asset).filter((a): a is ReleaseAsset => a !== null);
  // install.sh expects exactly these names.
  const dmg = assets.find((a) => a.name === `SKAZ-${version}-arm64.dmg`);
  if (!dmg || dmg.size <= 0 || dmg.size > MAX_DMG_BYTES) return null;
  const page = typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/all0b0y/SKAZ/releases/')
    ? r.html_url : `https://github.com/all0b0y/SKAZ/releases/tag/${encodeURIComponent(r.tag_name)}`;
  return { version, tag: r.tag_name, page, dmg, sums: assets.find((a) => a.name === SUMS_NAME) ?? null };
}

/** The SHA-256 SHA256SUMS.txt lists for `name` (`shasum -a 256` format), or null. */
export function sha256FromSums(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1]!.toLowerCase();
  }
  return null;
}

// ---- URL allow-list ----------------------------------------------------------------------------

const DOWNLOAD_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/** Only the releases API of SKAZ, its release downloads and GitHub's asset hosts; https only. */
export function isAllowedUpdateUrl(raw: string, purpose: 'api' | 'download'): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (purpose === 'api') return url.hostname === 'api.github.com' && url.pathname === '/repos/all0b0y/SKAZ/releases/latest';
  if (url.hostname === 'github.com') return url.pathname.startsWith('/all0b0y/SKAZ/releases/download/');
  return DOWNLOAD_HOSTS.has(url.hostname);
}

/** No update traffic from smoke, profile and test runs (they set these), or when switched off. */
export function updateChecksEnabled(env: Record<string, string | undefined>): boolean {
  if (env.SKAZ_UPDATE_CHECK === '0') return false;
  return !env.SKAZ_OPTIN_SMOKE_USER_DATA && !env.SKAZ_PROFILE_SMOKE_HOME;
}

// ---- commands ------------------------------------------------------------------------------------

/** hdiutil/codesign argv (no shell) that check SKAZ.app inside the DMG against SKAZ's certificate. */
export function signatureCommands(dmgPath: string, mountPoint: string): Array<{ command: string; args: string[] }> {
  return [
    { command: '/usr/bin/hdiutil', args: ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, dmgPath] },
    {
      command: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', `-R=certificate leaf = H"${CERT_SHA1}"`, `${mountPoint}/SKAZ.app`],
    },
  ];
}

/** The one-line installer run on the verified download: same script, local folder, this app's place. */
export function installerLaunch(options: { script: string; version: string; folderUrl: string; installDir: string; home: string }): {
  command: string; args: string[]; env: Record<string, string>;
} {
  return {
    command: '/bin/bash',
    args: [options.script],
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: options.home,
      SKAZ_VERSION: options.version, SKAZ_BASE_URL: options.folderUrl, SKAZ_INSTALL_DIR: options.installDir,
    },
  };
}

// ---- state -----------------------------------------------------------------------------------

export interface UpdaterStore {
  etag: string | null;
  release: unknown;
  notified: string | null;
}

export interface UpdaterDeps {
  version: string;
  packaged: boolean;
  /** False in smoke and test runs: nothing is fetched at all. */
  enabled: boolean;
  fetch: typeof fetch;
  now: () => Date;
  load: () => UpdaterStore;
  save: (store: UpdaterStore) => void;
  /** Folder for this version's download (created by the caller's `writeFile`). */
  downloadDir: (version: string) => string;
  writeFile: (path: string, chunks: AsyncIterable<Uint8Array>, onBytes: (bytes: number) => void) => Promise<number>;
  readText: (path: string) => Promise<string>;
  sha256: (path: string) => Promise<string>;
  /** codesign --verify of SKAZ.app inside the DMG against CERT_SHA1; a reason when it fails. */
  verifySignature: (dmgPath: string) => Promise<string | null>;
  /** Start install.sh detached on the downloaded folder; false when it couldn't start. */
  runInstaller: (version: string, folder: string) => Promise<boolean>;
  quit: () => void;
  notify: (version: string) => void;
  emit: (state: UpdateState) => void;
}

const COULDNT_CHECK = 'Couldn’t check';
export const DEV_REASON = 'Updates work in the installed app.';

export class Updater {
  private state: UpdateState;
  private store: UpdaterStore;
  private release: Release | null = null;
  private busy = false;
  private downloaded: { version: string; folder: string } | null = null;
  /** Stops the running download: Cancel, or nothing arrived for STALL_MS. */
  private abort: AbortController | null = null;

  constructor(private readonly deps: UpdaterDeps) {
    this.store = (() => { try { return deps.load(); } catch { return { etag: null, release: null, notified: null }; } })();
    const canInstall = deps.packaged && deps.enabled;
    this.state = {
      current: deps.version, phase: deps.enabled ? 'idle' : 'off', available: null, checkedAt: null, progress: null, error: null,
      canInstall, disabledReason: canInstall ? null : deps.enabled ? DEV_REASON : 'Update checks are off in this run.',
    };
  }

  get snapshot(): UpdateState {
    return { ...this.state };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.emit(this.snapshot);
  }

  private persist(): void {
    try { this.deps.save(this.store); } catch { /* the next check asks again */ }
  }

  /** Ask GitHub for the latest release; any failure is "Couldn't check" and nothing else. */
  async check(): Promise<UpdateState> {
    if (!this.deps.enabled || this.busy) return this.snapshot;
    if (['downloading', 'verifying', 'ready', 'installing'].includes(this.state.phase)) return this.snapshot;
    this.set({ phase: 'checking', error: null });
    let json: unknown = null;
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json', 'User-Agent': `SKAZ/${this.deps.version}`, 'X-GitHub-Api-Version': '2022-11-28',
      };
      if (this.store.etag && this.store.release) headers['If-None-Match'] = this.store.etag;
      const res = await this.deps.fetch(RELEASES_URL, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (res.status === 304) {
        json = this.store.release;
      } else if (res.ok) {
        json = await res.json() as unknown;
        this.store = { ...this.store, etag: res.headers.get('etag'), release: json };
        this.persist();
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      this.set({ phase: 'couldnt_check', checkedAt: this.deps.now().toISOString(), error: COULDNT_CHECK });
      return this.snapshot;
    }
    const release = parseRelease(json);
    const checkedAt = this.deps.now().toISOString();
    if (!release || (compareVersions(release.version, this.deps.version) ?? 0) <= 0) {
      this.release = null;
      this.set({ phase: 'up_to_date', available: null, checkedAt, error: null });
      return this.snapshot;
    }
    this.release = release;
    this.set({ phase: 'available', available: { version: release.version, page: release.page }, checkedAt, error: null });
    if (this.store.notified !== release.version) {
      this.store = { ...this.store, notified: release.version };
      this.persist();
      this.deps.notify(release.version);
    }
    return this.snapshot;
  }

  private async download(asset: ReleaseAsset, path: string, onBytes: (bytes: number) => void, signal: AbortSignal): Promise<number> {
    let url = asset.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowedUpdateUrl(url, 'download')) throw new Error('The download went to an address SKAZ doesn’t trust.');
      const res = await this.deps.fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': `SKAZ/${this.deps.version}` } });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        if (!next) throw new Error('The download was redirected nowhere.');
        url = new URL(next, url).toString();
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`);
      return this.deps.writeFile(path, res.body as unknown as AsyncIterable<Uint8Array>, onBytes);
    }
    throw new Error('The download was redirected too many times.');
  }

  /** Download and verify the new version (installed app only); `ready` asks the user next. */
  async prepare(): Promise<UpdateState> {
    const release = this.release;
    if (!this.state.canInstall) {
      this.set({ error: this.state.disabledReason ?? DEV_REASON });
      return this.snapshot;
    }
    if (!release || this.busy || !['available', 'failed'].includes(this.state.phase)) return this.snapshot;
    this.busy = true;
    const folder = this.deps.downloadDir(release.version);
    const abort = new AbortController();
    this.abort = abort;
    let lastBytes = this.deps.now().getTime();
    const stall = setInterval(() => {
      if (this.deps.now().getTime() - lastBytes >= STALL_MS) {
        abort.abort(new Error('The download stopped receiving data for a minute. Check the connection and try again.'));
      }
    }, 5_000);
    stall.unref?.();
    try {
      if (!release.sums) throw new Error('The release has no SHA256SUMS.txt, so the download can’t be checked. Not installing.');
      this.set({ phase: 'downloading', progress: 0, error: null });
      const sumsBytes = await this.download(release.sums, `${folder}/${SUMS_NAME}`, () => { lastBytes = this.deps.now().getTime(); }, abort.signal);
      if (sumsBytes > MAX_SUMS_BYTES) throw new Error('SHA256SUMS.txt is unexpectedly large. Not installing.');
      let received = 0;
      const dmgPath = `${folder}/${release.dmg.name}`;
      const size = await this.download(release.dmg, dmgPath, (bytes) => {
        lastBytes = this.deps.now().getTime();
        if (abort.signal.aborted) throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(CANCELLED);
        received += bytes;
        if (received > release.dmg.size) throw new Error('The download is bigger than the release says. Not installing.');
        this.set({ progress: Math.min(1, received / release.dmg.size) });
      }, abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(CANCELLED);
      this.set({ phase: 'verifying', progress: 1 });
      if (size !== release.dmg.size) throw new Error('The download is incomplete (its size doesn’t match the release). Not installing.');
      const actual = (await this.deps.sha256(dmgPath)).toLowerCase();
      const listed = sha256FromSums(await this.deps.readText(`${folder}/${SUMS_NAME}`), release.dmg.name);
      if (!listed || listed !== actual) throw new Error('The checksum doesn’t match SHA256SUMS.txt. Not installing.');
      if (release.dmg.sha256 && release.dmg.sha256 !== actual) throw new Error('The checksum doesn’t match the release. Not installing.');
      const signature = await this.deps.verifySignature(dmgPath);
      if (signature) throw new Error(signature);
      this.downloaded = { version: release.version, folder };
      this.set({ phase: 'ready', error: null });
    } catch (error) {
      this.downloaded = null;
      const reason: unknown = abort.signal.aborted ? abort.signal.reason : error;
      if (reason instanceof Error && reason.message === CANCELLED) {
        // The user stopped it: back to "available", nothing to report.
        this.set({ phase: 'available', progress: null, error: null });
      } else {
        this.set({ phase: 'failed', progress: null, error: reason instanceof Error ? reason.message : 'The update couldn’t be prepared.' });
      }
    } finally {
      clearInterval(stall);
      if (this.abort === abort) this.abort = null;
      this.busy = false;
    }
    return this.snapshot;
  }

  /** Stop a running download (M2). Verification and installing are not interrupted. */
  cancel(): UpdateState {
    if (this.state.phase === 'downloading') this.abort?.abort(new Error(CANCELLED));
    return this.snapshot;
  }

  /** After the user agreed that SKAZ closes: start install.sh on the verified download and quit. */
  async install(): Promise<boolean> {
    const ready = this.downloaded;
    if (!ready || this.state.phase !== 'ready' || !this.state.canInstall) return false;
    this.set({ phase: 'installing' });
    if (!(await this.deps.runInstaller(ready.version, ready.folder))) {
      this.set({ phase: 'failed', error: 'The installer couldn’t start. Try again, or install from the release page.' });
      return false;
    }
    this.deps.quit();
    return true;
  }
}
