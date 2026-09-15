import { describe, expect, it } from 'vitest';
import {
  isAllowedExternalUrl,
  audioUploadPath,
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
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/audio' })).toBeNull();
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/audio', body: {} })).toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/asr/live/capabilities' })).toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/asr/live' })).toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/asr/live/scheduler' })).toBeNull();
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/asr/live/advance', body: { through_sequence: 3 } })).toBeNull();
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/asr/live/update', body: {} })).toMatch(/not allowed/i);
  });

  it('bounds JSON bodies and audio upload metadata/body size', () => {
    expect(
      validateBridgeRequest({ method: 'PUT', path: '/settings', body: { model: 'x'.repeat(70_000) } }),
    ).toMatch(/body/i);
    expect(validateAudioUpload('s1', { sequence: 0, startMs: 0, endMs: 5_000 }, new ArrayBuffer(44))).toBeNull();
    expect(validateAudioUpload('../s', { sequence: 0, startMs: 0, endMs: 1 }, new ArrayBuffer(44))).toMatch(/session/i);
    expect(validateAudioUpload('s1', { sequence: -1, startMs: 0, endMs: 1 }, new ArrayBuffer(44))).toMatch(/sequence/i);
    expect(validateAudioUpload('s1', { sequence: 0, startMs: 2, endMs: 1 }, new ArrayBuffer(44))).toMatch(/time/i);
    expect(validateAudioUpload('s1', { sequence: 0, startMs: 2, endMs: 2 }, new ArrayBuffer(44))).toMatch(/time/i);
    expect(validateAudioUpload('s1', { sequence: 0, startMs: 0, endMs: 31_000 }, new ArrayBuffer(44))).toMatch(/duration/i);
  });

  it('does not expose persistence-only POST through the generic JSON bridge', () => {
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/audio/store', body: {} })).toMatch(/not allowed/i);
  });

  it('routes the narrow binary channels only to their exact POST targets', () => {
    expect(audioUploadPath('session / one', 'store')).toBe('/sessions/session%20%2F%20one/audio/store');
    expect(audioUploadPath('session / one', 'transcribe')).toBe('/sessions/session%20%2F%20one/audio');
  });

  // See .runtime/asr-local-contract.md: these are the UI-facing local-checkpoint
  // status/preparation endpoints. The renderer bridge must actually be allowed to
  // reach them — a store/API-client mock in the React suite cannot prove that;
  // this is the real allow-list enforced in main (ipc.ts).
  it('allows the local model preparation routes and rejects everything not in the contract', () => {
    expect(validateBridgeRequest({ method: 'GET', path: '/models/local/status' })).toBeNull();
    expect(
      validateBridgeRequest({ method: 'POST', path: '/models/local/prepare', body: { model: 'small' } }),
    ).toBeNull();
    // Wrong method for each route.
    expect(validateBridgeRequest({ method: 'GET', path: '/models/local/prepare' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'POST', path: '/models/local/status' })).toMatch(/not allowed/i);
    expect(
      validateBridgeRequest({
        method: 'DELETE',
        path: '/models/local',
        body: { provider: 'local-whisper', model: 'small', confirmation_model: 'small' },
      }),
    ).toBeNull();
    expect(validateBridgeRequest({ method: 'POST', path: '/models/local/delete' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'POST', path: '/models/local' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'GET', path: '/models/local/status/../../health' })).toMatch(/path/i);
  });
});
