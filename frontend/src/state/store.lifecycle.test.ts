import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../api/bridge';
import type { Note, Session, Settings } from '../api/types';

const recorderHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    elapsedMs: ReturnType<typeof vi.fn>;
  }>,
  pauseGate: null as null | (() => void),
  stopGate: null as null | (() => void),
}));

vi.mock('../audio/recorder', () => ({
  AudioRecorder: class {
    start = vi.fn(async () => undefined);
    pause = vi.fn(() => new Promise<void>((resolve) => { recorderHarness.pauseGate = resolve; }));
    resume = vi.fn(async () => undefined);
    stop = vi.fn(() => new Promise<void>((resolve) => { recorderHarness.stopGate = resolve; }));
    elapsedMs = vi.fn(() => 0);
    constructor(_callbacks: unknown) {
      recorderHarness.instances.push(this);
    }
  },
}));

import { useStore } from './store';

const settings = (over: Partial<Settings> = {}): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' },
  agent: { provider: 'openrouter', model: 'agent' },
  notes: { provider: 'openrouter', model: 'notes' },
  transcript_language: 'auto',
  output_language: 'ru',
  cloud_consent: false,
  ...over,
});

const session = (id: string, status: Session['status'] = 'stopped'): Session => ({
  id,
  title: id,
  created_at: '2026-09-06T00:00:00Z',
  status,
  duration_ms: status === 'stopped' ? 60_000 : 0,
});

// Replace only `request` with a plain mock; keeping BridgeApi's generic
// `request` signature in the intersection makes the mock unassignable.
const bridge = window.audiohelper as unknown as Omit<BridgeApi, 'request'> & {
  request: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  recorderHarness.instances.length = 0;
  recorderHarness.pauseGate = null;
  recorderHarness.stopGate = null;
  bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    if (req.method === 'POST' && req.path === '/sessions') {
      return { ok: true, status: 200, data: session('new-session') };
    }
    if (req.method === 'GET' && req.path === '/sessions/new-session') {
      return {
        ok: true,
        status: 200,
        data: { session: session('new-session'), segments: [], messages: [], notes: null },
      };
    }
    if (req.method === 'PATCH') {
      return { ok: true, status: 200, data: session(req.path.split('/').at(-1)!, 'recording') };
    }
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
  useStore.setState({
    settings: settings(),
    sessions: [],
    activeSessionId: null,
    detail: null,
    recorderState: 'idle',
    recorderError: null,
    queue: {
      pending: 0,
      inFlight: null,
      completed: 0,
      duplicates: 0,
      failed: [],
      droppedCount: 0,
      overflow: false,
      lastError: null,
    },
    asking: false,
    askError: null,
    notesGenerating: false,
    notesError: null,
  });
});

describe('recording lifecycle', () => {
  it('creates a distinct session before recording over a stopped session', async () => {
    useStore.setState({
      sessions: [session('old')],
      activeSessionId: 'old',
      detail: { segments: [{ id: 's', start_ms: 0, end_ms: 1, text: 'old' }], messages: [], notes: null },
    });
    await useStore.getState().startRecording();
    expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/sessions' }));
    expect(useStore.getState().activeSessionId).toBe('new-session');
  });

  it('requires consent before cloud ASR opens the microphone', async () => {
    useStore.setState({ settings: settings({ asr: { provider: 'openrouter', model: 'qwen/qwen3-asr-1.7b' } }) });
    await useStore.getState().startRecording();
    expect(recorderHarness.instances).toHaveLength(0);
    expect(bridge.request).not.toHaveBeenCalled();
    expect(useStore.getState().recorderError).toMatch(/consent/i);
  });

  it('stays processing throughout pause drain and blocks new sessions', async () => {
    await useStore.getState().startRecording();
    const pause = useStore.getState().pauseRecording();
    expect(useStore.getState().recorderState).toBe('processing');
    await useStore.getState().newSession();
    expect(bridge.request).toHaveBeenCalledTimes(3); // create, detail, recording status only
    recorderHarness.pauseGate?.();
    await pause;
    expect(useStore.getState().recorderState).toBe('paused');
  });

  it('stays processing throughout stop and does not expose Record early', async () => {
    await useStore.getState().startRecording();
    const stop = useStore.getState().stopRecording();
    expect(useStore.getState().recorderState).toBe('processing');
    recorderHarness.stopGate?.();
    await stop;
    expect(useStore.getState().recorderState).toBe('stopped');
  });
});

describe('async session isolation', () => {
  it('never appends an ask response after the user switches sessions', async () => {
    let resolveAsk!: (value: JsonResponse<unknown>) => void;
    bridge.request = vi.fn((req: BridgeRequest) => {
      if (req.path.endsWith('/ask')) return new Promise((resolve) => { resolveAsk = resolve; });
      throw new Error(`unexpected ${req.path}`);
    });
    useStore.setState({ activeSessionId: 'a', detail: { segments: [], messages: [], notes: null } });
    const request = useStore.getState().ask('What happened?');
    useStore.setState({ activeSessionId: 'b', detail: { segments: [], messages: [], notes: null } });
    resolveAsk({
      ok: true,
      status: 200,
      data: { answer: 'for a', citations: [], context: { start_ms: 0, end_ms: 1, scope: 'auto' }, model: 'm' },
    });
    await request;
    expect(useStore.getState().detail?.messages).toEqual([]);
  });

  it('never installs generated notes into another selected session', async () => {
    let resolveNotes!: (value: JsonResponse<Note>) => void;
    bridge.request = vi.fn((req: BridgeRequest) => {
      if (req.path.endsWith('/notes')) return new Promise((resolve) => { resolveNotes = resolve; });
      throw new Error(`unexpected ${req.path}`);
    });
    useStore.setState({ activeSessionId: 'a', detail: { segments: [], messages: [], notes: null } });
    const request = useStore.getState().generateNotes();
    useStore.setState({ activeSessionId: 'b', detail: { segments: [], messages: [], notes: null } });
    resolveNotes({
      ok: true,
      status: 200,
      data: { content: 'for a', created_at: '2026-09-06T00:00:00Z', model: 'm', citations: [] },
    });
    await request;
    expect(useStore.getState().detail?.notes).toBeNull();
  });
});
