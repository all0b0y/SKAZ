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

/**
 * The X display of a Linux run (e.g. under xvfb-run); empty on macOS. Smokes pass a minimal
 * environment, and without it Electron can't open a window on Linux at all.
 */
export function displayEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['DISPLAY', 'XAUTHORITY'] as const) {
    const value = process.env[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Chromium refuses to run as root without its sandbox switched off (a Linux container); a normal
 * user and macOS never get this switch.
 */
export function rootArgs(): string[] {
  return process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [];
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
    // An agent CLI the app started (Hermes setting up its tool environment in SKAZ's own agent folder) may
    // still be finishing for a few seconds after quit: retry instead of failing on cleanup.
    if (!options.keepProfile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  };
  try {
    app = await electron.launch({
      args: [...rootArgs(), path.join(root, 'scripts/optin-smoke/main.cjs')],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
        SKAZ_OPTIN_SMOKE_USER_DATA: profile,
        PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
        SKAZ_ALLOW_MODEL_DOWNLOAD: '0',
        SKAZ_UPDATE_CHECK: '0',
        ...displayEnv(),
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
