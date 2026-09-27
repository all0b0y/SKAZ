import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('dev and test use distinct real databases and libraries and persist after restart', async () => {
  test.setTimeout(120_000);
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-profiles-')));
  const launch = (profile: 'dev' | 'test') => electron.launch({
    args: [path.join(root, 'scripts/profile-smoke/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'production',
      SKAZ_PROFILE_SMOKE_HOME: home, SKAZ_PROFILE: profile, SKAZ_ALLOW_MODEL_DOWNLOAD: '0' },
  });
  try {
    for (const profile of ['dev', 'test', 'test'] as const) {
      const app = await launch(profile);
      try {
        const actual = await app.evaluate(({ app: main }) => ({
          user: main.getPath('userData'), session: main.getPath('sessionData'), documents: main.getPath('documents'),
        }));
        expect(actual).toEqual({ user: path.join(home, '.skaz', profile), session: path.join(home, '.skaz', profile),
          documents: path.join(home, 'Documents', `SKAZ-${profile}`) });
        const page = await app.firstWindow();
        await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase)).toBe('ready');
        const library = path.join(actual.documents, 'SKAZ');
        const result = await page.evaluate(async ({ profile, library, production }) => {
          const sessions = await window.skaz.request<{ sessions: { title: string }[] }>({ method: 'GET', path: '/sessions' });
          if (!sessions.ok) throw new Error('Session read failed');
          if (sessions.data.sessions.length === 0) {
            const refused = await window.skaz.request({ method: 'PUT', path: '/storage/root',
              body: { root: production, expected_root: null } });
            if (refused.ok) throw new Error('Production library accepted by development!');
            const chosen = await window.skaz.request({ method: 'PUT', path: '/storage/root',
              body: { root: library, expected_root: null } });
            if (!chosen.ok) throw new Error('Profile library refused');
            const created = await window.skaz.request({ method: 'POST', path: '/sessions', body: { title: profile } });
            if (!created.ok) throw new Error('Session create failed');
          }
          const again = await window.skaz.request<{ sessions: { title: string }[] }>({ method: 'GET', path: '/sessions' });
          if (!again.ok) throw new Error('Readback failed');
          return again.data.sessions.map((s) => s.title);
        }, { profile, library, production: path.join(home, 'Documents/SKAZ') });
        expect(result).toEqual([profile]);
      } finally { await app.close(); }
    }
    expect(await fs.readdir(path.join(home, '.skaz'))).toEqual(['dev', 'test']);
    await expect(fs.access(path.join(home, 'Documents/SKAZ'))).rejects.toThrow();
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
