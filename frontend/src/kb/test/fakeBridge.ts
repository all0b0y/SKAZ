// The fake bridge of component tests: `bridge.request` (a vi.fn) answers from one `FakeWorld`
// through the typed router of fakeKb.ts. A fake on the external seam for component tests only —
// it proves the UI's handling of answers, not the backend's behaviour.
import { vi } from 'vitest';
import type { BridgeRequest, JsonResponse, TextFileSave } from '../../api/bridge';
import { fakeDictate, serveFake, type FakeWorld } from './fakeKb';
import { baseWorld } from './fixtures';

export { baseWorld, chatWorld, docWorld, unconfiguredWorld, without } from './fixtures';

export function createFakeBridge(initial: FakeWorld = baseWorld()) {
  const world: FakeWorld = structuredClone(initial);
  const calls: BridgeRequest[] = [];
  const request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    calls.push(req);
    // Unknown routes answer like the IPC policy in main does for a route it doesn't allow.
    return serveFake(world, req) ?? { ok: false, status: 0, detail: `method/path not allowed: ${req.method} ${req.path}` };
  });
  let quitListener: (() => Promise<boolean>) | null = null;
  return {
    world,
    calls,
    /** What the renderer answers when main asks it to save before quitting (null = no listener). */
    prepareQuit: async () => (quitListener ? quitListener() : null),
    /** The mock behind `bridge.request`, for one-off failures in a test. */
    requestMock: request,
    bridge: {
      request: request as unknown as <T = unknown>(req: BridgeRequest) => Promise<JsonResponse<T>>,
      chooseStorageRoot: vi.fn(async () => '/Users/me/Notes'),
      chooseMaterialFiles: vi.fn(async () => [{ path: '/Users/me/Downloads/paper.pdf', name: 'paper.pdf', size: 120_000 }]),
      saveTextFile: vi.fn(async (file: TextFileSave) => ({ saved: true, path: `/Users/me/Downloads/${file.suggested_name}` })),
      dictate: vi.fn(fakeDictate(world)),
      reportCaptureState: vi.fn(),
      onPrepareQuit: vi.fn((listener: () => Promise<boolean>) => {
        quitListener = listener;
        return () => { if (quitListener === listener) quitListener = null; };
      }),
    },
  };
}
