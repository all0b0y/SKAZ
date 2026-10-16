import { describe, expect, it, vi } from 'vitest';
import {
  CERT_SHA1, DEV_REASON, RELEASES_URL, Updater, compareVersions, installerLaunch, isAllowedUpdateUrl, parseRelease,
  sha256FromSums, signatureCommands, updateChecksEnabled, type UpdaterDeps, type UpdaterStore,
} from '../../../electron/updates';

// Fixtures shaped like https://api.github.com/repos/all0b0y/SKAZ/releases/latest. No network here:
// `fetch` is a fake answering from these, so this proves the rules, not GitHub's behaviour.
const DMG_SHA = 'a'.repeat(64);
function releaseJson(version = '0.3.0', extra: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`, html_url: `https://github.com/all0b0y/SKAZ/releases/tag/v${version}`, draft: false, prerelease: false,
    assets: [
      { name: `SKAZ-${version}-arm64.dmg`, size: 12, browser_download_url: `https://github.com/all0b0y/SKAZ/releases/download/v${version}/SKAZ-${version}-arm64.dmg`, digest: `sha256:${DMG_SHA}` },
      { name: `SKAZ-${version}-arm64.pkg`, size: 40, browser_download_url: `https://github.com/all0b0y/SKAZ/releases/download/v${version}/SKAZ-${version}-arm64.pkg` },
      { name: 'SHA256SUMS.txt', size: 90, browser_download_url: `https://github.com/all0b0y/SKAZ/releases/download/v${version}/SHA256SUMS.txt` },
    ],
    ...extra,
  };
}

describe('Updates — versions and release JSON (B20)', () => {
  it('compares semver, pre-releases before the release, a leading v allowed', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.9', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1);
    expect(compareVersions('latest', '0.2.0')).toBeNull();
  });

  it('takes the DMG and SHA256SUMS.txt install.sh expects; refuses drafts, pre-releases and foreign URLs', () => {
    const release = parseRelease(releaseJson())!;
    expect(release.version).toBe('0.3.0');
    expect(release.dmg).toMatchObject({ name: 'SKAZ-0.3.0-arm64.dmg', size: 12, sha256: DMG_SHA });
    expect(release.sums?.name).toBe('SHA256SUMS.txt');
    expect(release.page).toBe('https://github.com/all0b0y/SKAZ/releases/tag/v0.3.0');
    expect(parseRelease(releaseJson('0.3.0', { draft: true }))).toBeNull();
    expect(parseRelease(releaseJson('0.3.0', { prerelease: true }))).toBeNull();
    expect(parseRelease(releaseJson('0.3.0', { tag_name: 'nightly' }))).toBeNull();
    const evil = releaseJson();
    (evil.assets[0] as { browser_download_url: string }).browser_download_url = 'https://evil.example/SKAZ-0.3.0-arm64.dmg';
    expect(parseRelease(evil)).toBeNull();
    const noDmg = releaseJson();
    noDmg.assets = noDmg.assets.slice(1);
    expect(parseRelease(noDmg)).toBeNull();
    expect(parseRelease(null)).toBeNull();
    const noDigest = releaseJson();
    delete (noDigest.assets[0] as { digest?: string }).digest;
    expect(parseRelease(noDigest)!.dmg.sha256).toBeNull();
  });

  it('reads SHA256SUMS.txt as shasum writes it', () => {
    const sums = `${DMG_SHA}  SKAZ-0.3.0-arm64.dmg\n${'b'.repeat(64)} *SKAZ-0.3.0-arm64.pkg\n`;
    expect(sha256FromSums(sums, 'SKAZ-0.3.0-arm64.dmg')).toBe(DMG_SHA);
    expect(sha256FromSums(sums, 'SKAZ-0.3.0-arm64.pkg')).toBe('b'.repeat(64));
    expect(sha256FromSums(sums, 'other.dmg')).toBeNull();
  });

  it('allow-list: the releases API of SKAZ, its downloads and GitHub asset hosts, https only', () => {
    expect(isAllowedUpdateUrl(RELEASES_URL, 'api')).toBe(true);
    expect(isAllowedUpdateUrl('https://api.github.com/repos/someone/SKAZ/releases/latest', 'api')).toBe(false);
    expect(isAllowedUpdateUrl('http://api.github.com/repos/all0b0y/SKAZ/releases/latest', 'api')).toBe(false);
    expect(isAllowedUpdateUrl('https://github.com/all0b0y/SKAZ/releases/download/v0.3.0/x.dmg', 'download')).toBe(true);
    expect(isAllowedUpdateUrl('https://objects.githubusercontent.com/github-production-release-asset/1', 'download')).toBe(true);
    expect(isAllowedUpdateUrl('https://release-assets.githubusercontent.com/x', 'download')).toBe(true);
    for (const url of ['https://github.com/all0b0y/Other/releases/download/x', 'https://evil.example/x', 'file:///tmp/x.dmg',
      'https://user:pw@github.com/all0b0y/SKAZ/releases/download/x', 'https://github.com:8443/all0b0y/SKAZ/releases/download/x', 'nonsense']) {
      expect(isAllowedUpdateUrl(url, 'download'), url).toBe(false);
    }
  });

  it('the signature check pins SKAZ’s certificate; the installer is install.sh on the local folder', () => {
    const [attach, verify] = signatureCommands('/c/SKAZ-0.3.0-arm64.dmg', '/tmp/mnt');
    expect(attach!.args).toEqual(['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', '/tmp/mnt', '/c/SKAZ-0.3.0-arm64.dmg']);
    expect(verify!.command).toBe('/usr/bin/codesign');
    expect(verify!.args).toContain(`-R=certificate leaf = H"${CERT_SHA1}"`);
    expect(verify!.args.at(-1)).toBe('/tmp/mnt/SKAZ.app');
    const launch = installerLaunch({ script: '/Applications/SKAZ.app/Contents/Resources/install.sh', version: '0.3.0', folderUrl: 'file:///c/0.3.0', installDir: '/Applications', home: '/Users/me' });
    expect(launch).toEqual({
      command: '/bin/bash', args: ['/Applications/SKAZ.app/Contents/Resources/install.sh'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/me', SKAZ_VERSION: '0.3.0', SKAZ_BASE_URL: 'file:///c/0.3.0', SKAZ_INSTALL_DIR: '/Applications' },
    });
  });
});

// ---- the updater on fakes ----------------------------------------------------------------------

function bodyOf(bytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
}

function setup(over: Partial<UpdaterDeps> & { answers?: Array<() => Response>; sums?: string; dmgBytes?: number } = {}) {
  let store: UpdaterStore = { etag: null, release: null, notified: null };
  const answers = over.answers ?? [() => new Response(JSON.stringify(releaseJson()), { status: 200, headers: { etag: '"e1"' } })];
  const files = new Map<string, number>();
  const states: string[] = [];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === RELEASES_URL) {
      const next = answers.shift();
      if (!next) throw new TypeError('offline');
      void init;
      return next();
    }
    if (u.endsWith('SHA256SUMS.txt')) return new Response(bodyOf(90), { status: 200 });
    if (u.endsWith('.dmg')) return new Response(bodyOf(over.dmgBytes ?? 12), { status: 200 });
    return new Response(null, { status: 404 });
  });
  const deps: UpdaterDeps = {
    version: '0.2.0', packaged: true, enabled: true,
    fetch: fetchFake as unknown as typeof fetch,
    now: () => new Date('2026-10-16T10:00:00Z'),
    load: () => store, save: (s) => { store = s; },
    downloadDir: (v) => `/cache/${v}`,
    writeFile: async (path, chunks, onBytes) => {
      let n = 0;
      for await (const chunk of chunks) { n += chunk.byteLength; onBytes(chunk.byteLength); }
      files.set(path, n);
      return n;
    },
    readText: async () => over.sums ?? `${DMG_SHA}  SKAZ-0.3.0-arm64.dmg\n`,
    sha256: async () => DMG_SHA,
    verifySignature: async () => null,
    runInstaller: vi.fn(async () => true),
    quit: vi.fn(),
    notify: vi.fn(),
    emit: (s) => { states.push(s.phase); },
    ...over,
  };
  return { updater: new Updater(deps), deps, fetchFake, files, states, store: () => store };
}

describe('Updates — the updater (fakes at fetch, files and processes)', () => {
  it('finds a newer release, notifies once per version, keeps the ETag; 304 changes nothing', async () => {
    const { updater, deps, fetchFake } = setup({
      answers: [
        () => new Response(JSON.stringify(releaseJson()), { status: 200, headers: { etag: '"e1"' } }),
        () => new Response(null, { status: 304 }),
      ],
    });
    const first = await updater.check();
    expect(first).toMatchObject({ phase: 'available', available: { version: '0.3.0' }, canInstall: true });
    const second = await updater.check();
    expect(second.phase).toBe('available');
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith('0.3.0');
    const [, init] = fetchFake.mock.calls[1]!;
    expect((init!.headers as Record<string, string>)['If-None-Match']).toBe('"e1"');
    expect((init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('the same or an older release is "up to date"; offline is a silent "Couldn’t check"', async () => {
    const same = setup({ answers: [() => new Response(JSON.stringify(releaseJson('0.2.0')), { status: 200 })] });
    expect((await same.updater.check()).phase).toBe('up_to_date');
    const offline = setup({ answers: [] });
    const state = await offline.updater.check();
    expect(state).toMatchObject({ phase: 'couldnt_check', error: 'Couldn’t check' });
    expect(offline.deps.notify).not.toHaveBeenCalled();
    const limited = setup({ answers: [() => new Response('{}', { status: 403 })] });
    expect((await limited.updater.check()).phase).toBe('couldnt_check');
  });

  it('development builds show the check result but never download', async () => {
    const dev = setup({ packaged: false });
    expect((await dev.updater.check()).phase).toBe('available');
    const after = await dev.updater.prepare();
    expect(after).toMatchObject({ canInstall: false, disabledReason: DEV_REASON, error: DEV_REASON });
    expect(dev.fetchFake.mock.calls.some(([u]) => String(u).endsWith('.dmg'))).toBe(false);
  });

  it('downloads, verifies size, SHA-256 and signature, then installs only when asked', async () => {
    const { updater, deps, files } = setup();
    await updater.check();
    const ready = await updater.prepare();
    expect(ready.phase).toBe('ready');
    expect(files.get('/cache/0.3.0/SKAZ-0.3.0-arm64.dmg')).toBe(12);
    expect(deps.runInstaller).not.toHaveBeenCalled();
    expect(await updater.install()).toBe(true);
    expect(deps.runInstaller).toHaveBeenCalledWith('0.3.0', '/cache/0.3.0');
    expect(deps.quit).toHaveBeenCalled();
  });

  it.each([
    ['a short download', { dmgBytes: 7 }, 'incomplete'],
    ['a checksum that doesn’t match SHA256SUMS.txt', { sums: `${'c'.repeat(64)}  SKAZ-0.3.0-arm64.dmg\n` }, 'SHA256SUMS'],
    ['SHA256SUMS.txt without the DMG', { sums: `${DMG_SHA}  other.dmg\n` }, 'SHA256SUMS'],
    ['a checksum that doesn’t match the release digest', { sha256: async () => 'd'.repeat(64), sums: `${'d'.repeat(64)}  SKAZ-0.3.0-arm64.dmg\n` }, 'the release'],
    ['a bad signature', { verifySignature: async () => 'SKAZ.app is not signed with SKAZ’s certificate. Not installing.' }, 'certificate'],
  ])('%s fails with the reason and never installs', async (_name, over, reason) => {
    const { updater, deps } = setup(over as Partial<UpdaterDeps>);
    await updater.check();
    const state = await updater.prepare();
    expect(state.phase).toBe('failed');
    expect(state.error).toContain(reason);
    expect(await updater.install()).toBe(false);
    expect(deps.runInstaller).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it('a release without SHA256SUMS.txt is never installed', async () => {
    const json = releaseJson();
    json.assets = json.assets.filter((a) => a.name !== 'SHA256SUMS.txt');
    const { updater, deps } = setup({ answers: [() => new Response(JSON.stringify(json), { status: 200 })] });
    await updater.check();
    expect((await updater.prepare()).error).toContain('SHA256SUMS.txt');
    expect(deps.runInstaller).not.toHaveBeenCalled();
  });

  it('a redirect to an untrusted host stops the download', async () => {
    const { updater, fetchFake } = setup();
    await updater.check();
    fetchFake.mockImplementation(async (url) => (String(url).endsWith('SHA256SUMS.txt')
      ? new Response(null, { status: 302, headers: { location: 'https://evil.example/sums' } })
      : new Response(null, { status: 404 })));
    const state = await updater.prepare();
    expect(state).toMatchObject({ phase: 'failed' });
    expect(state.error).toContain('doesn’t trust');
  });

  it('smoke, profile and switched-off runs never check', () => {
    expect(updateChecksEnabled({})).toBe(true);
    expect(updateChecksEnabled({ SKAZ_UPDATE_CHECK: '0' })).toBe(false);
    expect(updateChecksEnabled({ SKAZ_OPTIN_SMOKE_USER_DATA: '/tmp/p' })).toBe(false);
    expect(updateChecksEnabled({ SKAZ_PROFILE_SMOKE_HOME: '/tmp/h' })).toBe(false);
  });

  it('a run with update checks off fetches nothing', async () => {
    const off = setup({ enabled: false });
    expect((await off.updater.check()).phase).toBe('off');
    expect(off.fetchFake).not.toHaveBeenCalled();
  });

  it('an installer that can’t start leaves SKAZ running with the reason', async () => {
    const { updater, deps } = setup({ runInstaller: vi.fn(async () => false) });
    await updater.check();
    await updater.prepare();
    expect(await updater.install()).toBe(false);
    expect(updater.snapshot).toMatchObject({ phase: 'failed' });
    expect(deps.quit).not.toHaveBeenCalled();
  });
});
