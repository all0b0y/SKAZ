import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyProfile, resolveStorageProfile } from './storageProfile';

const roots: string[] = [];
function home(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skaz-profile-'));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const facts = { home: '/home/person', documents: '/home/person/Documents', packaged: false };

describe('storage profiles', () => {
  it('isolates normal development and explicit test from production', () => {
    const dev = resolveStorageProfile(facts);
    const test = resolveStorageProfile({ ...facts, requested: 'test' });
    const installed = resolveStorageProfile({ ...facts, packaged: true, requested: 'test' });
    expect(dev.name).toBe('dev');
    expect(test.name).toBe('test');
    expect(installed.name).toBe('default');
    expect(new Set([dev.userData, test.userData, installed.userData]).size).toBe(3);
    expect(new Set([dev.documents, test.documents, installed.documents]).size).toBe(3);
    expect(installed.userData).toBe('/home/person/.skaz/default');
    expect(installed.documents).toBe(facts.documents);
  });
  it('rejects unknown or production development profiles', () => {
    for (const requested of ['default', '../default', 'test-demo', '']) {
      expect(() => resolveStorageProfile({ ...facts, requested })).toThrow();
    }
  });
  it('moves the entire previous Electron profile once, including WAL and settings', () => {
    const root = home();
    const source = path.join(root, 'Library/Application Support/skaz');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data/skaz.sqlite3'), 'db');
    writeFileSync(path.join(source, 'data/skaz.sqlite3-wal'), 'wal');
    writeFileSync(path.join(source, 'Preferences'), 'preferences');
    const target = path.join(root, '.skaz/default');
    migrateLegacyProfile(root, target);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(path.join(target, 'data/skaz.sqlite3-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(path.join(target, 'Preferences'), 'utf8')).toBe('preferences');
    mkdirSync(path.join(source, 'data'), { recursive: true });
    writeFileSync(path.join(source, 'data/skaz.sqlite3'), 'older');
    migrateLegacyProfile(root, target);
    expect(readFileSync(path.join(target, 'data/skaz.sqlite3'), 'utf8')).toBe('db');
    expect(existsSync(source)).toBe(true);
  });
  it('prefers the current product installation over obsolete legacy copies', () => {
    const root = home();
    for (const name of ['skaz', 'AudioHelper']) {
      const data = path.join(root, 'Library/Application Support', name, 'data');
      mkdirSync(data, { recursive: true });
      writeFileSync(path.join(data, 'skaz.sqlite3'), name);
    }
    migrateLegacyProfile(root, path.join(root, '.skaz/default'));
    expect(readFileSync(path.join(root, '.skaz/default/data/skaz.sqlite3'), 'utf8')).toBe('skaz');
  });
  it.each(['.skaz', '.audiohelper'])('stages backend-only %s without copying dev/test profiles', (folder) => {
    const root = home();
    const source = path.join(root, folder);
    mkdirSync(source);
    writeFileSync(path.join(source, 'audiohelper.sqlite3'), 'legacy');
    if (folder === '.skaz') {
      mkdirSync(path.join(source, 'dev'));
      writeFileSync(path.join(source, 'dev/keep'), 'development');
    }
    const target = path.join(root, '.skaz/default');
    migrateLegacyProfile(root, target);
    expect(readFileSync(path.join(target, 'data/audiohelper.sqlite3'), 'utf8')).toBe('legacy');
    expect(existsSync(path.join(target, 'data/dev'))).toBe(false);
    expect(existsSync(path.join(target, 'data/.migration-lock'))).toBe(false);
  });
  it.runIf(process.platform === 'darwin')('refuses an open database and can retry after it closes', () => {
    const root = home();
    const source = path.join(root, '.audiohelper');
    mkdirSync(source);
    const fd = openSync(path.join(source, 'audiohelper.sqlite3'), 'w');
    const target = path.join(root, '.skaz/default');
    try {
      expect(() => migrateLegacyProfile(root, target)).toThrow('Quit the previous SKAZ backend');
      expect(existsSync(target)).toBe(false);
    } finally { closeSync(fd); }
    migrateLegacyProfile(root, target);
    expect(existsSync(target)).toBe(true);
  });
  it('does nothing to old data when resolving development profiles', () => {
    const root = home();
    const profile = resolveStorageProfile({ home: root, documents: root, packaged: false });
    expect(existsSync(profile.userData)).toBe(false);
    expect(existsSync(path.join(root, '.skaz/default'))).toBe(false);
  });
});
