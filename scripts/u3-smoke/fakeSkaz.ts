// Fake `window.skaz` for the U3 smoke: the built renderer runs in plain Chromium against the
// one fake backend (frontend/src/kb/test/fakeKb.ts) over the document world. Bundled by esbuild inside the smoke spec and injected as an
// init script, so it is the only bridge the page sees. Unknown routes are recorded, not invented.

import type { BridgeRequest, JsonResponse } from '../../frontend/src/api/bridge';
import { fakeNative, serveFake } from '../../frontend/src/kb/test/fakeKb';
import { docWorld } from '../../frontend/src/kb/test/fixtures';

const world = docWorld();
const native = fakeNative();
const unknown: string[] = [];

const skaz = {
  request: async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    const answer = serveFake(world, req);
    if (answer) return answer;
    unknown.push(`${req.method} ${req.path}`);
    return { ok: false, status: 404, detail: `Not in the U3 smoke world: ${req.method} ${req.path}` };
  },
  getBackendStatus: async () => ({ phase: 'ready' as const }),
  onBackendStatus: () => () => undefined,
  onPrepareQuit: () => () => undefined,
  reportCaptureState: () => undefined,
  chooseStorageRoot: async () => null,
  // "+ Material" → choose on the computer: a document with audio and video (QA B11 layout).
  chooseMaterialFiles: async () => [
    { path: '/Users/me/Downloads/good.pdf', name: 'good.pdf', size: 3_000 },
    { path: '/Users/me/Downloads/speech.wav', name: 'speech.wav', size: 223_000 },
    { path: '/Users/me/Downloads/clip.mp4', name: 'clip.mp4', size: 67_000 },
  ],
  systemAudioSupported: false,
  openNative: native.openNative,
  sendNativeAudio: native.sendNativeAudio,
  endNative: native.endNative,
  onNativeFailure: native.onNativeFailure,
};

Object.defineProperty(window, 'skaz', { value: skaz, configurable: false, writable: false });
Object.defineProperty(window, '__u3', { value: { world, native, unknown }, configurable: false, writable: false });
