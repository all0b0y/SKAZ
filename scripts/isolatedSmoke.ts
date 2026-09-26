import { _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Prove isolation before returning a window that a smoke may interact with. */
export async function launchIsolatedSmoke(prefix: string): Promise<{
  app: ElectronApplication;
  close: () => Promise<void>;
}> {
  const root = path.resolve(__dirname, '..');
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  let app: ElectronApplication | undefined;
  const close = async () => {
    // Do not delete an in-use profile if closing Electron fails.
    await app?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  };
  try {
    app = await electron.launch({
      args: [path.join(root, 'scripts/optin-smoke/main.cjs')],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
        AUDIOHELPER_OPTIN_SMOKE_USER_DATA: profile,
        PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
        AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
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
    return { app, close };
  } catch (error) {
    await close();
    throw error;
  }
}
