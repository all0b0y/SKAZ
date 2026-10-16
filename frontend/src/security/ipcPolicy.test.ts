import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, validateBridgeRequest } from '../../../electron/ipcPolicy';

describe('Electron IPC policy', () => {
  it('allows the recording transport and settings, not neighbouring mutations', () => {
    for (const [method, path] of [
      ['GET', '/settings'], ['PUT', '/settings'], ['GET', '/sessions/a/live'], ['PATCH', '/sessions/a'],
      ['GET', '/kb/recordings/a/live'],
    ] as const) expect(validateBridgeRequest({ method, path }), `${method} ${path}`).toBeNull();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(validateBridgeRequest({ method, path: '/sessions/a/live' })).not.toBeNull();
      expect(validateBridgeRequest({ method, path: '/kb/recordings/a/live' })).not.toBeNull();
    }
    // The renderer reads the live text from /kb/recordings/{id}/live; the session's raw event pages are closed.
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/live/events' })).not.toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/sessions/a/live/events/raw' })).not.toBeNull();
    expect(validateBridgeRequest({ method: 'DELETE', path: '/settings' })).not.toBeNull();
  });

  it('closes the replaced session, notes, search, upload, storage and Codex APIs', () => {
    // These used to be allowed. Knowledge Wiki has its own narrow /kb contract now.
    for (const [method, path] of [
      ['GET', '/web-search/settings'], ['PUT', '/web-search/settings'],
      ['GET', '/web-search/pending'], ['POST', '/web-search/requests/id/decision'],
      ['POST', '/web-search/search'], ['GET', '/storage/root'], ['PUT', '/storage/root'],
      ['GET', '/sessions/a/files'], ['POST', '/sessions/a/files'],
      ['POST', '/sessions/a/files/preserve'], ['POST', '/sessions/a/ask'],
      ['POST', '/sessions/a/audio'], ['POST', '/sessions/a/audio/buffer'],
      ['GET', '/sessions/a/audio'], ['GET', '/sessions/a/audio/0'],
      ['GET', '/sessions/a/notes/n/history'], ['POST', '/sessions/a/notes/empty'],
      ['DELETE', '/sessions/a/notes/n1'], ['PATCH', '/sessions/a/notes/n1'],
      ['GET', '/asr/live/capabilities'], ['GET', '/sessions/a/asr/live'],
      ['GET', '/sessions/a/asr/live/scheduler'], ['POST', '/sessions/a/asr/live/advance'],
      ['GET', '/sessions/a/asr/fragments'], ['PUT', '/sessions/a/asr/fragments/f1/text'],
      ['POST', '/sessions/a/asr/fragments/f1/accept'], ['GET', '/imports'],
      ['GET', '/imports/active'], ['POST', '/imports'], ['GET', '/imports/s1'],
      ['POST', '/imports/s1/cancel'], ['POST', '/imports/s1/retry'], ['DELETE', '/imports/s1'],
      ['GET', '/models/local/status'], ['POST', '/models/local/prepare'], ['DELETE', '/models/local'],
      ['GET', '/codex/state'], ['POST', '/codex/chats'], ['GET', '/codex/chats/c1'],
      ['PATCH', '/codex/chats/c1'], ['DELETE', '/codex/chats/c1'],
      ['POST', '/codex/chats/c1/messages'], ['POST', '/codex/tasks/t1/stop'],
      ['POST', '/codex/tasks/t1/resume'], ['POST', '/codex/sessions/s1/notes'],
      ['PUT', '/codex/settings'], ['POST', '/codex/connection/check'],
      ['POST', '/codex/connection/login'], ['POST', '/codex/connection/logout'],
      ['GET', '/codex/previews'], ['POST', '/codex/previews/p1/apply'],
      ['POST', '/codex/previews/p1/discard'], ['POST', '/codex/shell'], ['GET', '/codex/credentials'],
    ] as const) expect(validateBridgeRequest({ method, path }), `${method} ${path}`).toMatch(/not allowed/);
  });

  it('opens only http and https external links', () => {
    for (const url of ['https://example.com/help', 'http://example.com/help']) {
      expect(isAllowedExternalUrl(url)).toBe(true);
    }
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'skaz://settings', 'not a URL']) {
      expect(isAllowedExternalUrl(url)).toBe(false);
    }
  });

  it('rejects traversal, absolute URLs and control characters', () => {
    for (const path of ['http://evil.test/settings', '/kb/materials/../settings',
      '/kb/materials/%2e%2e/settings', '/kb/materials/a\\b', '/kb/materials/a\n']) {
      expect(validateBridgeRequest({ method: 'GET', path })).toMatch(/path/);
    }
  });

  it('rejects an encoded slash or backslash in an id (QA E3: "%2F" reached the list route)', () => {
    for (const path of ['/kb/materials/%2F', '/kb/chats/%2f', '/kb/wiki/pages/a%2Fb', '/kb/jobs/%5C',
      '/kb/materials/%2f/fragments']) {
      expect(validateBridgeRequest({ method: 'GET', path })).toMatch(/path/);
    }
    expect(validateBridgeRequest({ method: 'GET', path: '/kb/materials/mat-1' })).toBeNull();
  });

  it('bounds ordinary JSON and rejects non-serializable bodies', () => {
    expect(validateBridgeRequest({ method: 'PUT', path: '/settings',
      body: { model: 'x'.repeat(70_000) } })).toMatch(/body/);
    const body: { self?: unknown } = {};
    body.self = body;
    expect(validateBridgeRequest({ method: 'PUT', path: '/settings', body })).toMatch(/serializable/);
  });
});
