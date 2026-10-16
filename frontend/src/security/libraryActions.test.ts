import { describe, expect, it, vi } from 'vitest';
import {
  ExportFolders, isInside, obsidianInstalled, obsidianUrl, openInObsidian, resolveTarget, type LibraryActionDeps,
} from '../../../electron/libraryActions';

const ROOT = '/Users/me/Documents/SKAZ';

function deps(over: Partial<LibraryActionDeps> = {}, routes: Record<string, unknown> = {}): LibraryActionDeps {
  const table: Record<string, unknown> = {
    '/kb/library': { state: 'ready', root: ROOT },
    '/kb/wiki/pages/pg-1/file': { path: `${ROOT}/Wiki/Concepts/Entropy.md` },
    ...routes,
  };
  return {
    getJson: async (route) => table[route] ?? null,
    realPath: (p) => (p.includes('missing') ? null : p.replace('/link/', '/Wiki/')),
    isDirectory: (p) => !p.endsWith('.md'),
    isFile: (p) => p.endsWith('.md'),
    ...over,
  };
}

function memory(initial: string | null = null) {
  let text = initial;
  return { read: () => text, write: (t: string) => { text = t; }, get: () => text };
}

describe('Library file actions — named targets only (B20)', () => {
  it('the library: its real root as the backend reports it, only when ready', async () => {
    expect(await resolveTarget({ kind: 'library' }, deps(), new ExportFolders(memory()))).toEqual({ path: ROOT, directory: true });
    const notReady = deps({}, { '/kb/library': { state: 'not_configured', root: null } });
    expect(await resolveTarget({ kind: 'library' }, notReady, new ExportFolders(memory()))).toBeNull();
  });

  it('a page: the file the backend names, only inside the library root and only a .md file', async () => {
    const exports = new ExportFolders(memory());
    expect(await resolveTarget({ kind: 'page', id: 'pg-1' }, deps(), exports)).toEqual({ path: `${ROOT}/Wiki/Concepts/Entropy.md`, directory: false });
    const outside = deps({}, { '/kb/wiki/pages/pg-1/file': { path: '/etc/passwd.md' } });
    expect(await resolveTarget({ kind: 'page', id: 'pg-1' }, outside, exports)).toBeNull();
    const escape = deps({}, { '/kb/wiki/pages/pg-1/file': { path: `${ROOT}/../secrets.md` } });
    expect(await resolveTarget({ kind: 'page', id: 'pg-1' }, { ...escape, realPath: (p) => p.replace('/SKAZ/..', '') }, exports)).toBeNull();
    for (const id of ['../x', 'a/b', '', 'x'.repeat(200), 7]) {
      expect(await resolveTarget({ kind: 'page', id }, deps(), exports), String(id)).toBeNull();
    }
    const gone = deps({}, { '/kb/wiki/pages/pg-1/file': { path: `${ROOT}/missing.md` } });
    expect(await resolveTarget({ kind: 'page', id: 'pg-1' }, gone, exports)).toBeNull();
  });

  it('an export folder only when it was chosen in SKAZ’s export chooser (kept across runs)', async () => {
    const store = memory();
    const exports = new ExportFolders(store);
    expect(await resolveTarget({ kind: 'export', path: '/Users/me/Export' }, deps(), exports)).toBeNull();
    exports.remember('/Users/me/Export');
    expect(await resolveTarget({ kind: 'export', path: '/Users/me/Export' }, deps(), exports)).toEqual({ path: '/Users/me/Export', directory: true });
    expect(await resolveTarget({ kind: 'export', path: '/Users/me' }, deps(), exports)).toBeNull();
    expect(await resolveTarget({ kind: 'export', path: 'Export' }, deps(), exports)).toBeNull();
    const again = new ExportFolders(store);
    expect(again.has('/Users/me/Export')).toBe(true);
    expect(new ExportFolders(memory('not json')).has('/Users/me/Export')).toBe(false);
  });

  it('anything else is refused: URLs, unknown kinds, garbage', async () => {
    const exports = new ExportFolders(memory());
    for (const target of [null, 'file:///etc', { kind: 'url', path: 'https://x' }, { kind: 'export' }, { path: ROOT }]) {
      expect(await resolveTarget(target, deps(), exports), JSON.stringify(target)).toBeNull();
    }
    expect(isInside(ROOT, `${ROOT}/Wiki`)).toBe(true);
    expect(isInside(ROOT, '/Users/me/Documents/SKAZ-other')).toBe(false);
    expect(isInside(ROOT, ROOT)).toBe(true);
  });
});

describe('Open in Obsidian — fixed URL from a checked path (B20)', () => {
  it('builds obsidian://open?path= from the library root or a page file, nothing else', async () => {
    expect(obsidianUrl('/Users/me/Documents/SKAZ/Wiki/Concepts/Entropy (энтропия).md'))
      .toBe('obsidian://open?path=%2FUsers%2Fme%2FDocuments%2FSKAZ%2FWiki%2FConcepts%2FEntropy%20(%D1%8D%D0%BD%D1%82%D1%80%D0%BE%D0%BF%D0%B8%D1%8F).md');
    const openExternal = vi.fn(async () => undefined);
    const exports = new ExportFolders(memory());
    const d = { ...deps(), installed: () => true, openExternal };
    expect(await openInObsidian({ kind: 'library' }, d, exports)).toEqual({ ok: true });
    expect(openExternal).toHaveBeenLastCalledWith(obsidianUrl(ROOT));
    expect(await openInObsidian({ kind: 'page', id: 'pg-1' }, d, exports)).toEqual({ ok: true });
    expect(openExternal).toHaveBeenLastCalledWith(obsidianUrl(`${ROOT}/Wiki/Concepts/Entropy.md`));
    exports.remember('/Users/me/Export');
    for (const target of [{ kind: 'export', path: '/Users/me/Export' }, { kind: 'url', url: 'obsidian://x' }, 'obsidian://open?vault=x']) {
      expect(await openInObsidian(target, d, exports), JSON.stringify(target)).toEqual({ ok: false, reason: 'unavailable' });
    }
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('says honestly when Obsidian is not installed, and never opens anything then', async () => {
    const openExternal = vi.fn(async () => undefined);
    const result = await openInObsidian({ kind: 'library' }, { ...deps(), installed: () => false, openExternal }, new ExportFolders(memory()));
    expect(result).toEqual({ ok: false, reason: 'not_installed' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('detects Obsidian in /Applications, ~/Applications or as the obsidian:// handler', () => {
    const none = () => false;
    expect(obsidianInstalled('/Users/me', (p) => p === '/Applications/Obsidian.app', () => '')).toBe(true);
    expect(obsidianInstalled('/Users/me', (p) => p === '/Users/me/Applications/Obsidian.app', () => '')).toBe(true);
    expect(obsidianInstalled('/Users/me', none, () => 'Obsidian')).toBe(true);
    expect(obsidianInstalled('/Users/me', none, () => '')).toBe(false);
    expect(obsidianInstalled('/Users/me', none, () => { throw new Error('no'); })).toBe(false);
  });
});
