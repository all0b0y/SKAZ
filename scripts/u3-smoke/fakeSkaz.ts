// Fake `window.skaz` for the U3 smoke: the built renderer runs in plain Chromium against the
// in-memory U3 world (API-B2 shapes). Bundled by esbuild inside the smoke spec and injected as an
// init script, so it is the only bridge the page sees. Unknown routes are recorded, not invented.

import type { BridgeRequest, JsonResponse } from '../../frontend/src/api/bridge';
import { fakeNative, handleU3, u3World } from '../../frontend/src/kb/test/u3World';

const world = u3World();
const native = fakeNative();
const unknown: string[] = [];

const skaz = {
  request: async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    const answer = handleU3(world, req);
    if (answer) return answer;
    unknown.push(`${req.method} ${req.path}`);
    return { ok: false, status: 404, detail: `Not in the U3 smoke world: ${req.method} ${req.path}` };
  },
  getBackendStatus: async () => ({ phase: 'ready' as const }),
  onBackendStatus: () => () => undefined,
  onPrepareQuit: () => () => undefined,
  reportCaptureState: () => undefined,
  chooseStorageRoot: async () => null,
  systemAudioSupported: false,
  openNative: native.openNative,
  sendNativeAudio: native.sendNativeAudio,
  endNative: native.endNative,
  onNativeFailure: native.onNativeFailure,
};

Object.defineProperty(window, 'skaz', { value: skaz, configurable: false, writable: false });
Object.defineProperty(window, '__u3', { value: { world, native, unknown }, configurable: false, writable: false });
