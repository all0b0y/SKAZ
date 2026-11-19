import { createRoot } from 'react-dom/client';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';
import { KbApp } from '../KbApp';
import { createServices } from '../state/context';
import { PREFS_KEY } from '../state/prefs';
import '../styles/index.css';
import { createBrowserFake } from '../test/browserFake';
import { fragment } from '../test/fakeKb';
import { docWorld } from '../test/fixtures';
import type { CaptureCallbacks, CaptureEngine } from './capture';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const lateRead = params.has('lateRead');
localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true, theme, rightWidth: 320, motion: 'calm' }));
const fake = createBrowserFake(docWorld());
if (lateRead) {
  fake.world.liveOpen = '';
  fake.world.liveTail = '';
  fake.world.settings.native_recording_mode = 'transcription';
}
const readPaths: string[] = [];
const writes: string[] = [];
let callbacks: CaptureCallbacks;
let starts = 0;
let recoverRead = false;
const finalFragment = (id: string) => fragment(id, 2, 'A final sentence from the live poll.', { start_ms: 3000 });
const capture: CaptureEngine = {
  start: async (_params, next) => { starts += 1; callbacks = next; },
  pause: async () => undefined,
  resume: async () => undefined,
  stop: async () => true,
  elapsedMs: () => 42_000,
  pending: () => ({ pending: 0, failed: 0 }),
};
const services = createServices({
  ...fake.bridge,
  async request<T>(req: BridgeRequest): Promise<JsonResponse<T>> {
    const id = services.recording.getState().materialId;
    if (req.method === 'GET' && id && req.path === '/kb/materials/' + id) {
      readPaths.push(req.path);
      if (lateRead && (readPaths.length === 1 || recoverRead)) {
        const detail = fake.world.materials.find((material) => material.id === id)!;
        detail.fragments = [fragment(id, 1, 'A sentence from material detail.', { start_ms: 1000 })];
        if (recoverRead) detail.fragments.push({ ...finalFragment(id), text: 'The authoritative final sentence.' });
        return fake.bridge.request<T>(req);
      }
      return { ok: false, status: 503, detail: 'The recording could not be read.' };
    }
    if (req.method === 'POST' && (req.path === '/kb/recordings' || req.path.endsWith('/resume'))) {
      writes.push(req.path);
    }
    return fake.bridge.request<T>(req);
  },
}, localStorage, { capture: () => capture });

declare global {
  interface Window {
    livePanelFixture: {
      failRecognition: () => void;
      addFinalFragment: () => void;
      recoverRead: () => void;
      observed: () => { id: string | null; readPaths: string[]; writes: string[]; starts: number };
    };
  }
}

window.livePanelFixture = {
  failRecognition: () => callbacks.onFailure('The recognition service stopped answering.'),
  addFinalFragment: () => {
    const id = services.recording.getState().materialId!;
    services.recording.setState({
      liveFragments: [finalFragment(id)],
      live: { material_id: id, after_seg: 2, stream: 'streaming', monologues: [], partial: null },
    });
  },
  recoverRead: () => { recoverRead = true; },
  observed: () => ({ id: services.recording.getState().materialId, readPaths, writes, starts }),
};
createRoot(document.getElementById('root')!).render(<KbApp services={services} />);
