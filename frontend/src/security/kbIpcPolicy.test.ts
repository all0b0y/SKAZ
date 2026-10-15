import { describe, expect, it } from 'vitest';
import { validateBridgeRequest } from '../../../electron/ipcPolicy';

describe('Electron IPC policy — knowledge library (/kb) routes of the new interface', () => {
  it('allows exactly the library, folder, material and notification calls the shell makes', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/kb/library'], ['POST', '/kb/library'], ['POST', '/kb/library/retry'],
      ['GET', '/kb/folders'], ['POST', '/kb/folders'],
      ['PATCH', '/kb/folders/fld_1'], ['DELETE', '/kb/folders/fld_1'],
      ['GET', '/kb/materials'], ['GET', '/kb/materials/mat_1'],
      ['GET', '/kb/notifications'],
    ];
    for (const [method, path] of allowed) {
      expect(validateBridgeRequest({ method, path }), `${method} ${path}`).toBeNull();
    }
  });

  it('refuses neighbouring methods and paths no screen of this package uses', () => {
    const refused: Array<[string, string]> = [
      ['DELETE', '/kb/library'], ['PUT', '/kb/library'],
      ['DELETE', '/kb/folders'], ['GET', '/kb/folders/fld_1/files'],
      ['POST', '/kb/materials'], ['DELETE', '/kb/materials/mat_1'], ['PATCH', '/kb/materials/mat_1'],
      ['GET', '/kb/notifications/n1'],
      ['GET', '/kb/wiki/pages'], ['GET', '/kb'],
    ];
    for (const [method, path] of refused) {
      expect(validateBridgeRequest({ method, path }), `${method} ${path}`).not.toBeNull();
    }
  });

  it('allows the package-2 calls of chat, composer, ⌘K, notifications, settings and first launch (U2)', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/kb/chats'], ['POST', '/kb/chats'], ['GET', '/kb/chats/events'],
      ['GET', '/kb/chats/c1'], ['PATCH', '/kb/chats/c1'], ['DELETE', '/kb/chats/c1'],
      ['POST', '/kb/chats/c1/messages'], ['GET', '/kb/chats/c1/events'],
      ['POST', '/kb/chats/c1/messages/m1/stop'], ['POST', '/kb/chats/c1/messages/m1/regenerate'],
      ['POST', '/kb/chats/c1/messages/m1/resume'], ['POST', '/kb/chats/c1/messages/m1/save'],
      ['POST', '/kb/chats/c1/save'], ['POST', '/kb/chats/c1/read'], ['GET', '/kb/chats/c1/export'],
      ['GET', '/kb/mentions'],
      ['POST', '/kb/notifications/n1/resolve'], ['POST', '/kb/notifications/n1/dismiss'], ['POST', '/kb/notifications/read'],
      ['GET', '/kb/materials/m1/corrections'], ['POST', '/kb/corrections/k1/accept'], ['POST', '/kb/corrections/k1/keep'],
      ['GET', '/kb/materials/m1/excluded'], ['POST', '/kb/materials/m1/excluded/4/restore'],
      ['GET', '/kb/search'], ['GET', '/kb/wiki/pages/p1'],
      ['GET', '/kb/settings/health'], ['POST', '/kb/settings/health/hermes-missing/install'],
      ['GET', '/kb/settings/keys'], ['PUT', '/kb/settings/keys/soniox'], ['POST', '/kb/settings/keys/openrouter/check'],
      ['GET', '/kb/settings/speech'], ['PUT', '/kb/settings/speech'], ['GET', '/kb/settings/privacy'], ['GET', '/kb/settings/about'],
      ['GET', '/kb/settings/wiki'], ['PUT', '/kb/settings/wiki'], ['POST', '/kb/wiki/connections/find'],
      ['GET', '/kb/agents'], ['PUT', '/kb/agents/default'], ['POST', '/kb/agents/hermes/install'],
      ['POST', '/kb/agents/codex/login'], ['POST', '/kb/agents/claude_code/check'],
      ['GET', '/kb/agents/install/t1'], ['POST', '/kb/agents/install/t1/cancel'],
      ['GET', '/kb/decisions'], ['PUT', '/kb/decisions/provider'], ['POST', '/kb/decisions/local/download'], ['POST', '/kb/decisions/local/cancel'],
      ['POST', '/kb/materials/file'], ['POST', '/kb/materials/link'], ['POST', '/kb/materials/text'],
      ['POST', '/kb/materials/m1/ingest'], ['POST', '/kb/imports'], ['POST', '/kb/links/classify'],
    ];
    for (const [method, path] of allowed) {
      expect(validateBridgeRequest({ method, path }), `${method} ${path}`).toBeNull();
    }
  });

  it('refuses package-2 neighbours no U2 screen uses', () => {
    const refused: Array<[string, string]> = [
      ['PUT', '/kb/chats/c1'], ['DELETE', '/kb/chats'], ['POST', '/kb/chats/c1/messages/m1/delete'],
      ['PUT', '/kb/settings/keys/github'], ['GET', '/kb/settings/keys/soniox'], ['DELETE', '/kb/settings/keys/soniox'],
      ['POST', '/kb/agents/other/install'], ['POST', '/kb/agents/codex/logout'], ['DELETE', '/kb/decisions/local'],
      ['POST', '/kb/materials/m1/excluded/x/restore'], ['POST', '/kb/dictation'], ['POST', '/kb/notifications/n1/delete'],
      ['GET', '/kb/chats/c1/events/x'], ['POST', '/kb/chats/../x/read'],
    ];
    for (const [method, path] of refused) {
      expect(validateBridgeRequest({ method, path }), `${method} ${path}`).not.toBeNull();
    }
  });

  it('keeps ids to one segment and rejects traversal through a folder id', () => {
    expect(validateBridgeRequest({ method: 'PATCH', path: '/kb/folders/a/b' })).not.toBeNull();
    expect(validateBridgeRequest({ method: 'DELETE', path: '/kb/folders/..' })).not.toBeNull();
    expect(validateBridgeRequest({ method: 'DELETE', path: '/kb/folders/%2e%2e' })).not.toBeNull();
    expect(validateBridgeRequest({ method: 'GET', path: '/kb/materials/x\\y' })).not.toBeNull();
  });

  it('bounds a folder-name body like every other JSON body', () => {
    expect(validateBridgeRequest({ method: 'POST', path: '/kb/folders', body: { name: 'Physics' } })).toBeNull();
    expect(validateBridgeRequest({ method: 'POST', path: '/kb/folders', body: { name: 'x'.repeat(70_000) } }))
      .toMatch(/too large/);
  });
});
