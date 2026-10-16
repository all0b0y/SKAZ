import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__pycache__' || name === 'node_modules') return [];
    return statSync(full).isDirectory() ? filesUnder(full, ext) : ext.test(name) ? [full] : [];
  });
}

/** `SKAZ_*` keys a launcher sets in the backend's / the smoke app's environment. */
const keysSetIn = (file: string) => [...new Set(readFileSync(path.join(repoRoot, file), 'utf8').match(/\bSKAZ_[A-Z_]+(?=\s*:)/g) ?? [])];

describe('Environment the launchers pass (G7 leftovers)', () => {
  // Whoever reads a variable: the backend, Electron's main process, the smoke fixtures.
  const readers = [
    ...filesUnder(path.join(repoRoot, 'backend/src'), /\.py$/),
    ...filesUnder(path.join(repoRoot, 'electron'), /\.ts$/).filter((f) => !f.endsWith('backend.ts') && !f.endsWith('.test.ts')),
    ...filesUnder(path.join(repoRoot, 'scripts/fake-soniox'), /\.py$/),
    ...filesUnder(path.join(repoRoot, 'scripts/optin-smoke'), /\.c?js$/),
  ].map((f) => readFileSync(f, 'utf8'));

  for (const launcher of ['electron/backend.ts', 'scripts/isolatedSmoke.ts']) {
    it(`${launcher} sets only variables something still reads`, () => {
      const keys = keysSetIn(launcher);
      expect(keys.length).toBeGreaterThan(0);
      const unread = keys.filter((key) => !readers.some((source) => source.includes(key)));
      expect(unread).toEqual([]);
    });
  }
});
