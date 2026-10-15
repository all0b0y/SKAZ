// The browser smoke's bridge (scripts/kb-u2.smoke.spec.ts): the one fake backend (fakeKb.ts) over
// the chat world, with a real-feeling round trip. Pure — no test-runner imports. A fake on the
// external seam: it shows the UI's handling of contract-shaped answers; the real backend is
// exercised by the Electron smoke (kb-shell).

import type { BridgeApi, BridgeRequest, JsonResponse } from '../../api/bridge';
import { fakeDictate, serveFake, type FakeWorld } from './fakeKb';
import { chatWorld } from './fixtures';

export interface BrowserFake {
  world: FakeWorld;
  bridge: Pick<BridgeApi, 'request'> & Partial<BridgeApi>;
}

export function createBrowserFake(world: FakeWorld = chatWorld()): BrowserFake {
  const request = async <T = unknown>(req: BridgeRequest): Promise<JsonResponse<T>> => {
    const answer = serveFake(world, req) ?? { ok: false as const, status: 404, detail: `Not found: ${req.method} ${req.path}` };
    // A real round trip is never instant.
    await new Promise((r) => setTimeout(r, 30));
    return answer as JsonResponse<T>;
  };
  return {
    world,
    bridge: {
      request,
      dictate: fakeDictate(world),
      saveTextFile: async (file) => ({ saved: true, path: `/Users/me/Downloads/${file.suggested_name}` }),
      chooseMaterialFiles: async () => [{ path: '/Users/me/Downloads/paper.pdf', name: 'paper.pdf', size: 120_000 }],
      chooseStorageRoot: async () => '/Users/me/Notes',
    },
  };
}
