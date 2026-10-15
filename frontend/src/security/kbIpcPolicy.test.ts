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
      ['POST', '/kb/notifications/n1/dismiss'], ['GET', '/kb/notifications/n1'],
      ['GET', '/kb/wiki/pages'], ['GET', '/kb/search'], ['GET', '/kb'],
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
