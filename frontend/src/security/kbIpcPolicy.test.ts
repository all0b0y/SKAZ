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
    // PATCH/DELETE of a material and the wiki page list became U3 routes (see the U3 block below).
    const refused: Array<[string, string]> = [
      ['DELETE', '/kb/library'], ['PUT', '/kb/library'],
      ['DELETE', '/kb/folders'], ['GET', '/kb/folders/fld_1/files'],
      ['POST', '/kb/materials'], ['PUT', '/kb/materials/mat_1'], ['GET', '/kb/materials/mat_1/file'],
      ['POST', '/kb/notifications/n1/dismiss'], ['GET', '/kb/notifications/n1'],
      ['DELETE', '/kb/wiki/pages/p1'], ['GET', '/kb/search'], ['GET', '/kb'],
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

describe('Electron IPC policy — U3 screens (wiki page, material, all materials, add, recording, graph)', () => {
  it('allows the package-2 routes the U3 screens call', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/kb/wiki/pages'], ['GET', '/kb/wiki/pages/p1'],
      ['POST', '/kb/wiki/pages/p1/blocks'], ['PUT', '/kb/wiki/pages/p1/blocks/c-1'],
      ['DELETE', '/kb/wiki/pages/p1/blocks/c-1'], ['POST', '/kb/wiki/pages/p1/blocks/c-1/recheck'],
      ['PATCH', '/kb/materials/mat_1'], ['DELETE', '/kb/materials/mat_1'],
      ['GET', '/kb/materials/mat_1/delete-preview'], ['GET', '/kb/materials/mat_1/corrections'],
      ['GET', '/kb/materials/mat_1/excluded'], ['POST', '/kb/materials/mat_1/excluded/12/restore'],
      ['POST', '/kb/materials/mat_1/ingest'],
      ['POST', '/kb/materials/file'], ['POST', '/kb/materials/link'], ['POST', '/kb/materials/text'],
      ['POST', '/kb/links/classify'],
      ['POST', '/kb/corrections/c1/revert'], ['POST', '/kb/corrections/c1/accept'],
      ['POST', '/kb/corrections/c1/keep'], ['POST', '/kb/corrections/c1/reapply'],
      ['GET', '/kb/jobs'], ['GET', '/kb/jobs/j1'], ['GET', '/kb/graph'], ['GET', '/kb/settings/wiki'],
      ['GET', '/kb/recordings/defaults'], ['POST', '/kb/recordings'], ['GET', '/kb/recordings/mat_1'],
      ['POST', '/kb/recordings/mat_1/stop'], ['POST', '/kb/recordings/mat_1/pause'], ['POST', '/kb/recordings/mat_1/resume'],
      ['POST', '/kb/imports'], ['POST', '/kb/chats'],
      // The live tail and recording settings of the existing pipeline.
      ['GET', '/sessions/s1/live/events'], ['GET', '/sessions/s1/live'], ['GET', '/settings'], ['PUT', '/settings'],
    ];
    for (const [method, path] of allowed) {
      expect(validateBridgeRequest({ method, path }), `${method} ${path}`).toBeNull();
    }
  });

  it('refuses unknown actions, wrong methods and multi-segment ids', () => {
    const refused: Array<[string, string]> = [
      ['POST', '/kb/corrections/c1/delete'], ['GET', '/kb/corrections/c1/revert'],
      ['POST', '/kb/materials/mat_1/excluded/x/restore'], ['POST', '/kb/materials/other'],
      ['DELETE', '/kb/recordings/mat_1'], ['POST', '/kb/recordings/mat_1/delete'],
      ['PUT', '/kb/wiki/pages/p1'], ['POST', '/kb/wiki/pages/p1/blocks/c-1/edit'],
      ['GET', '/kb/wiki/pages/a/b'], ['POST', '/kb/graph'], ['DELETE', '/kb/jobs/j1'],
    ];
    for (const [method, path] of refused) {
      expect(validateBridgeRequest({ method, path }), `${method} ${path}`).not.toBeNull();
    }
  });
});
