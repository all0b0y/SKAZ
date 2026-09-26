import { execFile } from 'node:child_process';

// An app launched from Finder/Dock inherits launchd's PATH (/usr/bin:/bin:…),
// not the user's shell PATH, so tools installed in ~/.local/bin, Homebrew or
// nvm are invisible to the backend. Read the login shell's PATH once, bounded
// by a timeout; on any failure return null and let the backend fall back to
// standard install folders. The value is only a search path, never executed.

const MARKER = '__SKAZ_PATH__';
export const LOGIN_SHELL_TIMEOUT_MS = 3_000;

type Exec = (
  file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string) => void,
) => void;

/** Pull the PATH printed between markers; shell startup noise is ignored. */
export function parseShellPath(stdout: string): string | null {
  const start = stdout.indexOf(MARKER);
  const end = stdout.indexOf(MARKER, start + MARKER.length);
  if (start < 0 || end < 0) return null;
  const value = stdout.slice(start + MARKER.length, end).trim();
  if (!value || value.includes('\n') || !value.split(':').some((p) => p.startsWith('/'))) return null;
  return value;
}

export function readLoginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  exec: Exec = execFile as unknown as Exec,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform === 'win32') return Promise.resolve(null);
  const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/zsh';
  return new Promise((resolve) => {
    try {
      exec(shell, ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`],
        { timeout: LOGIN_SHELL_TIMEOUT_MS, env: { ...env, TERM: 'dumb' } },
        (_error, stdout) => resolve(parseShellPath(String(stdout ?? ''))));
    } catch {
      resolve(null);
    }
  });
}
