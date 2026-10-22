import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const { smokeBackendOptions } = require('../../../scripts/optin-smoke/backend-env.cjs') as {
  smokeBackendOptions: (root: string, command: string, options: { env: Record<string, string> }, fixture?: string) => { env: Record<string, string> };
};
const python = path.join(root, 'backend/.venv/bin/python');
const fixture = path.join(root, 'scripts/fake-soniox');

describe('Smoke backend uses this checkout and its known offline fixture', () => {
  it('restores the Soniox fixture after the production environment filter removed PYTHONPATH', () => {
    const options = { env: { SKAZ_SMOKE_FAKE_SONIOX: 'words', SKAZ_TOKEN: 'fixture-token' } };
    const actual = smokeBackendOptions(root, python, options, fixture);
    expect(actual.env.PYTHONPATH).toBe([fixture, path.join(root, 'backend/src')].join(path.delimiter));
    expect(actual.env.SKAZ_TOKEN).toBe('fixture-token');
    expect(options.env).not.toHaveProperty('PYTHONPATH');
  });

  it('loads this checkout rather than a shared virtualenv editable install', () => {
    const actual = smokeBackendOptions(root, python, { env: {} });
    expect(actual.env.PYTHONPATH).toBe(path.join(root, 'backend/src'));
  });

  it('refuses an unrecognised or missing fixture before a recording can reach a provider', () => {
    for (const source of ['/untrusted/python', undefined]) {
      expect(() => smokeBackendOptions(root, python, { env: { SKAZ_SMOKE_FAKE_SONIOX: 'words' } }, source)).toThrow(/fixture/i);
    }
    expect(() => smokeBackendOptions(root, python, { env: {} }, '/untrusted/python')).toThrow(/fixture/i);
  });

  it('does not change agent or media subprocesses', () => {
    const options = { env: { SKAZ_SMOKE_FAKE_SONIOX: 'words' } };
    expect(smokeBackendOptions(root, '/usr/bin/other', options, fixture)).toBe(options);
  });
});
