import { expect, it } from 'vitest';
import { validateBridgeRequest } from '../../../../electron/ipcPolicy';

it('permits exactly the new Materials usage routes through Electron', () => {
  for (const [method, path] of [
    ['GET', '/kb/materials-activity/explore-unused'],
    ['POST', '/kb/materials-activity/explore-unused/keep'],
    ['POST', '/kb/materials/m-1/opened'],
    ['POST', '/kb/materials/m-1/new-topic'],
  ] as const) expect(validateBridgeRequest({ method, path })).toBeNull();
  expect(validateBridgeRequest({ method: 'DELETE', path: '/kb/materials-activity/explore-unused' })).not.toBeNull();
});
