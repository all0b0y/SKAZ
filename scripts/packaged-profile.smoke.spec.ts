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
        const titles = await page.evaluate(async () => {
          const response = await window.skaz.request<{ sessions: { title: string }[] }>({ method: 'GET', path: '/sessions' });
          if (!response.ok) throw new Error('Packaged session read failed');
          return response.data.sessions.map((s) => s.title);
        });
        expect(titles).toEqual(launch === 0 ? [] : ['Installer persistence fixture']);
        if (launch === 0) {
          const saved = await page.evaluate(() => window.skaz.request({ method: 'POST', path: '/sessions',
            body: { title: 'Installer persistence fixture' } }));
          expect(saved.ok).toBe(true);
        }
      } finally { await app.close(); }
    }
    expect(await fs.stat(path.join(profile, 'data/skaz.sqlite3'))).toBeTruthy();
  } finally { await fs.rm(profile, { recursive: true, force: true }); }
});
