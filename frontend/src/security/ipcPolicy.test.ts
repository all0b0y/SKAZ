import { describe, expect, it } from 'vitest';
import {
  isAllowedExternalUrl,
  validateAudioUpload,
  validateBridgeRequest,
} from '../../../electron/ipcPolicy';

describe('Electron IPC policy', () => {
  it('opens only http and https external links', () => {
    expect(isAllowedExternalUrl('https://example.com/help')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com/help')).toBe(true);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('audiohelper://settings')).toBe(false);
  });

  it('allows only documented method/path pairs', () => {
    expect(validateBridgeRequest({ method: 'GET', path: '/settings' })).toBeNull();
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/ask', body: { question: 'x' } })).toBeNull();
    expect(validateBridgeRequest({ method: 'DELETE', path: '/settings' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'GET', path: 'http://evil.test/settings' })).toMatch(/path/i);
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/%2e%2e/settings' })).toMatch(/path/i);
  });

  it('bounds JSON bodies and audio upload metadata/body size', () => {
    expect(
      validateBridgeRequest({ method: 'PUT', path: '/settings', body: { model: 'x'.repeat(70_000) } }),
    ).toMatch(/body/i);
    expect(validateAudioUpload('s1', { sequence: 0, startMs: 0, endMs: 5_000 }, new ArrayBuffer(44))).toBeNull();
    expect(validateAudioUpload('../s', { sequence: 0, startMs: 0, endMs: 1 }, new ArrayBuffer(44))).toMatch(/session/i);
    expect(validateAudioUpload('s1', { sequence: -1, startMs: 0, endMs: 1 }, new ArrayBuffer(44))).toMatch(/sequence/i);
    expect(validateAudioUpload('s1', { sequence: 0, startMs: 2, endMs: 1 }, new ArrayBuffer(44))).toMatch(/time/i);
    expect(validateAudioUpload('s1', { sequence: 0, startMs: 0, endMs: 31_000 }, new ArrayBuffer(44))).toMatch(/duration/i);
  });
});
