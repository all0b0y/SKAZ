import { expect, test, _electron as electron } from '@playwright/test';
import { displayEnv, rootArgs } from './isolatedSmoke';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('dev and test use distinct real databases and knowledge libraries and persist after restart', async () => {
  test.setTimeout(120_000);
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-profiles-')));
  const launch = (profile: 'dev' | 'test') => electron.launch({
    args: [...rootArgs(), path.join(root, 'scripts/profile-smoke/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'production',
      SKAZ_PROFILE_SMOKE_HOME: home, SKAZ_PROFILE: profile, SKAZ_ALLOW_MODEL_DOWNLOAD: '0', ...displayEnv() },
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
        const result = await page.evaluate(async ({ profile, production }) => {
          type Folder = { name: string; system: boolean };
          const state = await window.skaz.request<{ state: string; root: string | null }>({ method: 'GET', path: '/kb/library' });
          if (!state.ok) throw new Error('Library read failed');
          if (state.data.state !== 'ready') {
            const refused = await window.skaz.request({ method: 'POST', path: '/kb/library', body: { path: production } });
            if (refused.ok) throw new Error('Production library accepted by development!');
            const chosen = await window.skaz.request({ method: 'POST', path: '/kb/library', body: {} });
            if (!chosen.ok) throw new Error('Profile library refused');
            const created = await window.skaz.request({ method: 'POST', path: '/kb/folders', body: { name: profile } });
            if (!created.ok) throw new Error('Folder create failed');
          }
          const again = await window.skaz.request<{ root: string | null }>({ method: 'GET', path: '/kb/library' });
          const folders = await window.skaz.request<Folder[]>({ method: 'GET', path: '/kb/folders' });
          if (!again.ok || !folders.ok) throw new Error('Readback failed');
          return { root: again.data.root, folders: folders.data.filter((f) => !f.system).map((f) => f.name) };
        }, { profile, production: path.join(home, 'Documents/SKAZ') });
        expect(result).toEqual({ root: library, folders: [profile] });
      } finally { await app.close(); }
    }
    expect(await fs.readdir(path.join(home, '.skaz'))).toEqual(['dev', 'test']);
    await expect(fs.access(path.join(home, 'Documents/SKAZ'))).rejects.toThrow();
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
