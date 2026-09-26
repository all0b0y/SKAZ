import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDeclinedForever,
  shouldOfferMoveToApplications,
  writeDeclinedForever,
  type InstallLocationFacts,
} from './installLocation';

// A SKAZ launched from the DMG or Downloads shows up as a second app in
// Launchpad. These pin exactly when the "Move to Applications" offer appears.

const outside: InstallLocationFacts = {
  platform: 'darwin',
  isPackaged: true,
  isInApplicationsFolder: false,
  declinedForever: false,
  customUserData: false,
};

describe('shouldOfferMoveToApplications', () => {
  it('offers the move for a packaged Mac app running outside Applications', () => {
    expect(shouldOfferMoveToApplications(outside)).toBe(true);
  });

  it('stays quiet once the app is in Applications', () => {
    expect(shouldOfferMoveToApplications({ ...outside, isInApplicationsFolder: true })).toBe(false);
  });

  it('never interrupts development runs, other platforms or isolated profiles', () => {
    expect(shouldOfferMoveToApplications({ ...outside, isPackaged: false })).toBe(false);
    expect(shouldOfferMoveToApplications({ ...outside, platform: 'win32' })).toBe(false);
    expect(shouldOfferMoveToApplications({ ...outside, customUserData: true })).toBe(false);
  });

  it('respects "Don\'t ask again"', () => {
    expect(shouldOfferMoveToApplications({ ...outside, declinedForever: true })).toBe(false);
  });
});

describe('declined preference', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skaz-install-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips and treats a missing or corrupt file as "ask"', () => {
    expect(readDeclinedForever(dir)).toBe(false);
    writeFileSync(join(dir, 'install-location.json'), '{not json');
    expect(readDeclinedForever(dir)).toBe(false);
    writeDeclinedForever(dir);
    expect(readDeclinedForever(dir)).toBe(true);
  });

  it('creates the userData folder on a very first launch', () => {
    const fresh = join(dir, 'not-yet');
    writeDeclinedForever(fresh);
    expect(readDeclinedForever(fresh)).toBe(true);
  });
});
