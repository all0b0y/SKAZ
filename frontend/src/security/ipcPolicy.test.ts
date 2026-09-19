import { describe, expect, it } from 'vitest';
import {
  isAllowedExternalUrl,
  audioUploadPath,
  validateAudioUpload,
  validateBridgeRequest,
} from '../../../electron/ipcPolicy';

describe('Electron IPC policy', () => {
  it('allows only GET and PUT of the root preference, not arbitrary file access', () => {
    for (const method of ['GET', 'PUT']) {
      expect(validateBridgeRequest({ method, path: '/storage/root' })).toBeNull();
    }
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      expect(validateBridgeRequest({ method, path: '/storage/root' })).not.toBeNull();
    }
    expect(validateBridgeRequest({ method: 'GET', path: '/storage/root/file' })).not.toBeNull();
  });
  it('allows only session-scoped file status and explicit projection, never filesystem operations', () => {
    for (const method of ['GET', 'POST']) {
      expect(validateBridgeRequest({ method, path: '/sessions/a/files' })).toBeNull();
    }
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      expect(validateBridgeRequest({ method, path: '/sessions/a/files' })).toMatch(/not allowed/i);
    }
    for (const path of ['/files', '/sessions/a/files/delete', '/sessions/a/files/../../settings']) {
      expect(validateBridgeRequest({ method: 'POST', path })).not.toBeNull();
    }
  });
  it('opens only http and https external links', () => {
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/files/preserve' })).toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/files/preserve' })).not.toBeNull();
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

  it('allows every import route the dialog and panel call', () => {
    // Regression guard: the bridge allow-list is the one place where a missing
    // route makes the whole feature fail silently at runtime.
    expect(validateBridgeRequest({ method: 'GET', path: '/imports' })).toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/imports/active' })).toBeNull();
    expect(validateBridgeRequest({
      method: 'POST', path: '/imports', body: { path: '/a/b.m4a', title: 'x', translate: false },
    })).toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/imports/s1' })).toBeNull();
    expect(validateBridgeRequest({ method: 'POST', path: '/imports/s1/cancel' })).toBeNull();
    expect(validateBridgeRequest({ method: 'POST', path: '/imports/s1/retry' })).toBeNull();
    expect(validateBridgeRequest({ method: 'DELETE', path: '/imports/s1' })).toBeNull();
    // Neighbouring shapes stay closed.
    expect(validateBridgeRequest({ method: 'PUT', path: '/imports/s1' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'POST', path: '/imports/s1/start' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'GET', path: '/imports/s1/../settings' })).toMatch(/path/i);
  });

  // Regression: the renderer calls these four routes (NotesPanel "create note",
  // TranscriptView fragment load/edit/accept). They were missing from the
  // allow-list, so note creation failed and the live transcript stayed empty.
  it('allows note creation and the live fragment routes the renderer actually calls', () => {
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/notes/empty' })).toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/asr/fragments' })).toBeNull();
    expect(
      validateBridgeRequest({ method: 'PUT', path: '/sessions/a/asr/fragments/f1/text', body: { text: 'x' } }),
    ).toBeNull();
    expect(
      validateBridgeRequest({ method: 'POST', path: '/sessions/a/asr/fragments/f1/accept', body: {} }),
    ).toBeNull();
    // Neighbouring shapes stay closed.
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/notes/empty' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/notes/n1/text' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'DELETE', path: '/sessions/a/asr/fragments/f1' })).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'POST', path: '/sessions/a/asr/fragments' })).toMatch(/not allowed/i);
  });

  it('allows soft deletion of one note and nothing adjacent', () => {
    expect(validateBridgeRequest({ method: 'DELETE', path: '/sessions/a/notes/n1' })).toBeNull();
    // Deleting every note of a session is not an action the renderer may take.
    expect(validateBridgeRequest({ method: 'DELETE', path: '/sessions/a/notes' })).toMatch(/not allowed/i);
    expect(
      validateBridgeRequest({ method: 'DELETE', path: '/sessions/a/notes/n1/history' }),
    ).toMatch(/not allowed/i);
    expect(validateBridgeRequest({ method: 'PUT', path: '/sessions/a/notes/n1' })).toMatch(/not allowed/i);
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
