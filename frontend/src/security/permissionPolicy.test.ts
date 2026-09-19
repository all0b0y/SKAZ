import { describe, it, expect } from 'vitest';
import {
  isTrustedMediaRequest,
  isTrustedMediaCheck,
  type MediaRequestContext,
  type MediaCheckContext,
} from '../../../electron/permissionPolicy';

const EXPECTED_URL = 'file:///app/dist/renderer/index.html';
const EXPECTED_ORIGIN = 'file://';

const req = (over: Partial<MediaRequestContext> = {}): MediaRequestContext => ({
  permission: 'media',
  fromTrustedWebContents: true,
  requestingUrl: EXPECTED_URL,
  mediaTypes: ['audio'],
  ...over,
});

const chk = (over: Partial<MediaCheckContext> = {}): MediaCheckContext => ({
  permission: 'media',
  fromTrustedWebContents: true,
  requestingOrigin: EXPECTED_ORIGIN,
  isMainFrame: true,
  mediaType: 'audio',
  ...over,
});

describe('media permission request handler trust', () => {
  it('grants audio-only capture from the exact trusted renderer', () => {
    expect(isTrustedMediaRequest(req(), EXPECTED_URL)).toBe(true);
  });

  it('denies a non-media permission', () => {
    expect(isTrustedMediaRequest(req({ permission: 'geolocation' }), EXPECTED_URL)).toBe(false);
  });

  it('denies requests from a webContents that is not the main window', () => {
    expect(isTrustedMediaRequest(req({ fromTrustedWebContents: false }), EXPECTED_URL)).toBe(false);
  });

  it('denies a missing requesting URL instead of trusting it', () => {
    expect(isTrustedMediaRequest(req({ requestingUrl: undefined }), EXPECTED_URL)).toBe(false);
  });

  it('denies dev-prefix lookalikes and foreign hosts', () => {
    const expected = 'http://localhost:5173/';
    expect(isTrustedMediaRequest(req({ requestingUrl: 'http://localhost:5173.evil.com/' }), expected)).toBe(false);
    expect(isTrustedMediaRequest(req({ requestingUrl: 'http://localhost:51730/' }), expected)).toBe(false);
    expect(isTrustedMediaRequest(req({ requestingUrl: 'http://localhost:5173/' }), expected)).toBe(true);
  });

  it('denies video and denies unknown/empty media types by default', () => {
    expect(isTrustedMediaRequest(req({ mediaTypes: ['audio', 'video'] }), EXPECTED_URL)).toBe(false);
    expect(isTrustedMediaRequest(req({ mediaTypes: ['video'] }), EXPECTED_URL)).toBe(false);
    expect(isTrustedMediaRequest(req({ mediaTypes: [] }), EXPECTED_URL)).toBe(false);
    expect(isTrustedMediaRequest(req({ mediaTypes: undefined }), EXPECTED_URL)).toBe(false);
  });
});

describe('media permission check handler trust', () => {
  it('allows an audio check from the trusted main frame + origin', () => {
    expect(isTrustedMediaCheck(chk(), EXPECTED_ORIGIN)).toBe(true);
  });

  it('denies subframe requests', () => {
    expect(isTrustedMediaCheck(chk({ isMainFrame: false }), EXPECTED_ORIGIN)).toBe(false);
  });

  it('denies a foreign origin', () => {
    expect(isTrustedMediaCheck(chk({ requestingOrigin: 'https://evil.test' }), EXPECTED_ORIGIN)).toBe(false);
  });

  it('denies untrusted webContents', () => {
    expect(isTrustedMediaCheck(chk({ fromTrustedWebContents: false }), EXPECTED_ORIGIN)).toBe(false);
  });

  it('denies an explicit video/unknown media subtype', () => {
    expect(isTrustedMediaCheck(chk({ mediaType: 'video' }), EXPECTED_ORIGIN)).toBe(false);
    expect(isTrustedMediaCheck(chk({ mediaType: 'unknown' }), EXPECTED_ORIGIN)).toBe(false);
  });

  it('still allows when the subtype is absent (pre-check), preserving real mic capability', () => {
    expect(isTrustedMediaCheck(chk({ mediaType: undefined }), EXPECTED_ORIGIN)).toBe(true);
  });

  /**
   * Regression: Chromium passes the file origin as 'file:///' (three slashes),
   * while the expected origin is derived as 'file://'. `new URL(...).origin` is
   * the string "null" for file URLs, so the fallback comparison never matched
   * either and every check was denied. Capture still worked — the request
   * handler matches on the full URL — but Chromium hides device labels without
   * a granted check, so the picker could only render "Microphone 1".
   */
  it('allows the file origin exactly as Chromium spells it', () => {
    expect(isTrustedMediaCheck(chk({ requestingOrigin: 'file:///' }), 'file://')).toBe(true);
    expect(isTrustedMediaCheck(chk({ requestingOrigin: 'file://' }), 'file://')).toBe(true);
  });

  it('does not let the file-origin allowance widen to other schemes', () => {
    expect(isTrustedMediaCheck(chk({ requestingOrigin: 'file:///' }), 'http://localhost:5273')).toBe(false);
    expect(isTrustedMediaCheck(chk({ requestingOrigin: 'https://evil.test' }), 'file://')).toBe(false);
  });
});
