import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Safety gate BEFORE executing smoke code: a failing isolation test must never
// reproduce the bug by launching Electron against the user's real profile.
describe('smoke entry point isolation', () => {
  for (const name of ['smoke.spec.ts', 'visual-capture.smoke.spec.ts']) {
    it(`${name} routes every launch through the verified disposable profile helper`, () => {
      const source = readFileSync(path.resolve('scripts', name), 'utf8');
      expect(source).not.toMatch(/electron\.launch\s*\(/);
      expect(source).toContain("from './isolatedSmoke'");
      expect(source).not.toContain('SKAZ_SHOT_USER_DATA');
      expect(source).not.toContain('...process.env');
    });
  }
});
