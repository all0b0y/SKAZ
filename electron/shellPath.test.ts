import { describe, expect, it } from 'vitest';
import { parseShellPath, readLoginShellPath } from './shellPath';

describe('parseShellPath', () => {
  it('ignores shell startup noise around the markers', () => {
    expect(parseShellPath('Welcome!\n__SKAZ_PATH__/Users/me/.local/bin:/usr/bin__SKAZ_PATH__'))
      .toBe('/Users/me/.local/bin:/usr/bin');
  });

  it('rejects missing markers, empty or non-path values', () => {
    expect(parseShellPath('')).toBeNull();
    expect(parseShellPath('__SKAZ_PATH____SKAZ_PATH__')).toBeNull();
    expect(parseShellPath('__SKAZ_PATH__garbage__SKAZ_PATH__')).toBeNull();
    expect(parseShellPath('__SKAZ_PATH__/a\n/b__SKAZ_PATH__')).toBeNull();
  });
});

describe('readLoginShellPath', () => {
  it('runs the user shell as a login shell with a timeout', async () => {
    const calls: { file: string; args: string[]; timeout: number }[] = [];
    const result = await readLoginShellPath({ SHELL: '/bin/bash' }, (file, args, options, cb) => {
      calls.push({ file, args, timeout: options.timeout });
      cb(null, '__SKAZ_PATH__/opt/homebrew/bin:/usr/bin__SKAZ_PATH__');
    }, 'darwin');
    expect(result).toBe('/opt/homebrew/bin:/usr/bin');
    expect(calls[0]!.file).toBe('/bin/bash');
    expect(calls[0]!.args[0]).toBe('-ilc');
    expect(calls[0]!.timeout).toBe(3000);
  });

  it('returns null on failure or timeout instead of throwing', async () => {
    const failed = await readLoginShellPath({}, (_f, _a, _o, cb) => cb(new Error('timeout'), ''), 'darwin');
    expect(failed).toBeNull();
    const thrown = await readLoginShellPath({}, () => { throw new Error('spawn'); }, 'darwin');
    expect(thrown).toBeNull();
  });

  it('falls back to zsh for a relative or missing SHELL', async () => {
    let used = '';
    await readLoginShellPath({ SHELL: 'bash' }, (file, _a, _o, cb) => { used = file; cb(null, ''); }, 'darwin');
    expect(used).toBe('/bin/zsh');
  });

  it('really reads a PATH from this machine', async () => {
    if (process.platform === 'win32') return;
    const value = await readLoginShellPath();
    expect(value === null || value.includes('/')).toBe(true);
  });
});
