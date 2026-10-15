import { _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface IsolatedSmokeOptions {
  /** Reopen this existing isolated profile (a restart) instead of creating a new one. */
  profile?: string;
  /** Leave the profile on disk when closing, so the next launch can reopen it. */
  keepProfile?: boolean;
  /** Extra environment for the app and its backend (fixtures such as scripts/fake-soniox). */
  env?: Record<string, string>;
}

/** Prove isolation before returning a window that a smoke may interact with. */
export async function launchIsolatedSmoke(prefix: string, options: IsolatedSmokeOptions = {}): Promise<{
  app: ElectronApplication;
  close: () => Promise<void>;
  profile: string;
}> {
  const root = path.resolve(__dirname, '..');
  const profile = options.profile
    ? fs.realpathSync(options.profile)
    : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  let app: ElectronApplication | undefined;
  const close = async () => {
    // Do not delete an in-use profile if closing Electron fails.
    await app?.close();
    if (!options.keepProfile) fs.rmSync(profile, { recursive: true, force: true });
  };
  try {
    app = await electron.launch({
      args: [path.join(root, 'scripts/optin-smoke/main.cjs')],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
        SKAZ_OPTIN_SMOKE_USER_DATA: profile,
        PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
        SKAZ_ALLOW_MODEL_DOWNLOAD: '0',
        ...options.env,
      },
    });
    const actual = await app.evaluate(({ app: main }) => ({
      user: main.getPath('userData'), session: main.getPath('sessionData'), documents: main.getPath('documents'),
    }));
    if (fs.realpathSync(actual.user) !== profile
      || fs.realpathSync(actual.session) !== path.join(profile, 'session')
      || fs.realpathSync(actual.documents) !== path.join(profile, 'Documents')) {
      throw new Error('Smoke profile isolation failed; refusing UI interaction.');
    }
    return { app, close, profile };
  } catch (error) {
    await close();
    throw error;
  }
}
