import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('packaged installer starts empty and preserves its isolated profile on restart', async () => {
  const bundle = process.env.SKAZ_PACKAGED_SMOKE_APP;
  test.skip(!bundle, 'Requires an app copied from the actual DMG; never use the personal installation.');
  test.setTimeout(120_000);
  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-installed-profile-')));
  try {
    for (let launch = 0; launch < 2; launch++) {
      const app = await electron.launch({
        executablePath: path.join(bundle!, 'Contents/MacOS/SKAZ'),
        args: [`--user-data-dir=${profile}`],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '', SKAZ_PROFILE: 'test' },
      });
      try {
        expect(await app.evaluate(({ app: main }) => ({
          packaged: main.isPackaged, user: main.getPath('userData'), documents: main.getPath('documents'),
        }))).toEqual({ packaged: true, user: profile, documents: path.join(profile, 'Documents') });
        const page = await app.firstWindow();
        await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
          { timeout: 45_000 }).toBe('ready');
        const folders = await page.evaluate(async () => {
          const library = await window.skaz.request<{ state: string }>({ method: 'GET', path: '/kb/library' });
          if (!library.ok) throw new Error('Packaged library read failed');
          if (library.data.state !== 'ready') return [];
          const response = await window.skaz.request<{ name: string; system: boolean }[]>({ method: 'GET', path: '/kb/folders' });
          if (!response.ok) throw new Error('Packaged folder read failed');
          return response.data.filter((f) => !f.system).map((f) => f.name);
        });
        expect(folders).toEqual(launch === 0 ? [] : ['Installer persistence fixture']);
        if (launch === 0) {
          const saved = await page.evaluate(async () => {
            const library = await window.skaz.request({ method: 'POST', path: '/kb/library', body: {} });
            if (!library.ok) return false;
            const folder = await window.skaz.request({ method: 'POST', path: '/kb/folders', body: { name: 'Installer persistence fixture' } });
            return folder.ok;
          });
          expect(saved).toBe(true);
        }
      } finally { await app.close(); }
    }
    expect(await fs.stat(path.join(profile, 'data/knowledge.sqlite3'))).toBeTruthy();
  } finally { await fs.rm(profile, { recursive: true, force: true }); }
});
