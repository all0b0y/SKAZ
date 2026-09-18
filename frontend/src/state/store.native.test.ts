import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest } from '../api/bridge';
import type { Settings } from '../api/types';

// External browser and IPC boundaries; production store, recorder and writer.
let deliver: (data: Float32Array) => void;
let releaseBarrier: () => void;
const trackStop = vi.fn();
const session = { id: 'native-test', title: 'Native', created_at: '', status: 'stopped' as const, duration_ms: 0, mode: 'legacy' as const };
const settings: Settings = {
  used_languages: ['ru', 'en'],
  asr: { provider: 'local-whisper', model: 'small' }, agent: { provider: 'openrouter', model: 'agent' },
  notes: { provider: 'openrouter', model: 'notes' }, transcript_language: 'auto', output_language: 'ru',
  cloud_consent: false, contextual_local_enabled: false,
};
let saved = 0;
let sequence = 0;
let loseAck = false;
let bridge: BridgeApi;
let useStore: (typeof import('./store'))['useStore'];

beforeEach(async () => {
  vi.resetModules();
  saved = 0; sequence = 0; loseAck = false;
  trackStop.mockClear();
  class Context {
    sampleRate = 16000;
    state = 'running';
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  class Worklet {
    port = {
      onmessage: null as null | ((event: { data: Float32Array | { type: string; id: number } }) => void),
      postMessage: (data: { type: string; id: number }) => { releaseBarrier = () => this.port.onmessage?.({ data }); },
      close() {},
    };
    disconnect() {}
    constructor() { deliver = (data) => this.port.onmessage?.({ data }); }
  }
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.stubGlobal('navigator', { mediaDevices: {
    getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }], getAudioTracks: () => [{ stop: trackStop, addEventListener() {} }] }),
    enumerateDevices: async () => [],
  } });
  bridge = {
    ...window.audiohelper,
    request: vi.fn(async (req: BridgeRequest) => {
      if (req.path === '/sessions' && req.method === 'POST') return { ok: true, status: 200, data: session };
      if (req.path === '/sessions' && req.method === 'GET') return { ok: true, status: 200, data: { sessions: [session] } };
      if (req.path === '/sessions/native-test' && req.method === 'GET') return { ok: true, status: 200, data: { session, segments: [], messages: [], notes: null } };
      if (req.path === '/sessions/native-test' && req.method === 'PATCH') return { ok: true, status: 200, data: session };
      return { ok: false, status: 404, detail: 'not found' };
    }) as BridgeApi['request'],
    openNative: vi.fn<BridgeApi['openNative']>(async (_id, rate) => ({ ok: true, status: 200, data: {
      connection_id: 'fixture', sample_rate: rate, saved_samples: saved, next_sequence: sequence, transcription: 'unavailable',
    } })),
    sendNativeAudio: vi.fn<BridgeApi['sendNativeAudio']>(async (_id, meta, pcm) => {
      expect(meta).toEqual({ sequence, startSample: saved });
      sequence += 1; saved += pcm.byteLength / 2;
      if (loseAck) { loseAck = false; return { ok: false, status: 0, detail: 'ACK lost' }; }
      return { ok: true, status: 200, data: { sequence: meta.sequence, saved_samples: saved, duplicate: false } };
    }),
    endNative: vi.fn<BridgeApi['endNative']>(async (_id, action) => ({ ok: true, status: 200, data: {
      saved_samples: saved, status: action === 'pause' ? 'paused' : 'stopped', transcription_complete: false,
    } })),
    onNativeFailure: vi.fn(() => () => {}),
  };
  window.audiohelper = bridge;
  useStore = (await import('./store')).useStore;
  useStore.setState({ settings, ready: true });
});
afterEach(async () => {
  if (useStore && ['recording', 'paused', 'processing'].includes(useStore.getState().recorderState)) {
    const stopped = useStore.getState().stopRecording();
    releaseBarrier?.();
    await stopped;
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native Record lifecycle', () => {
  it('continues a reopened session instead of creating a new session or resetting the sample clock', async () => {
    saved = 16000; sequence = 10;
    const note = { id: 'n1', revision: 1, content: 'Original note', model: 'fixture', created_at: '', citations: [], stale: false };
    useStore.setState({
      sessions: [{ ...session, duration_ms: 1000 }], activeSessionId: session.id,
      recorderState: 'stopped', detail: { segments: [], messages: [], notes: note, notes_list: [note] },
    });
    await useStore.getState().resumeRecording();
    expect(useStore.getState().recorderState).toBe('recording');
    expect(bridge.openNative).toHaveBeenCalledWith(session.id, 16000);
    expect(vi.mocked(bridge.request).mock.calls.some(([r]) => r.method === 'POST' && r.path === '/sessions')).toBe(false);
    expect(useStore.getState().detail?.notes?.stale).toBe(false);
    deliver(new Float32Array(1600).fill(0.25));
    await vi.waitFor(() => expect(saved).toBe(17600));
    await vi.waitFor(() => expect(useStore.getState().detail?.notes?.stale).toBe(true));
    expect(useStore.getState().detail?.notes_list).toEqual([{ ...note, stale: true }]);
    expect(vi.mocked(bridge.request).mock.calls.some(([r]) => r.method === 'POST' && r.path.endsWith('/notes'))).toBe(false);
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    await stopping;
    expect(bridge.sendNativeAudio).toHaveBeenLastCalledWith(session.id, { sequence: 10, startSample: 16000 }, expect.any(ArrayBuffer));
  });
  it.each(['newSession', 'startRecording'] as const)('uses local date and minute without a Session prefix for %s', async (action) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 16, 14, 35, 49));
    await useStore.getState()[action]();
    const request = vi.mocked(bridge.request).mock.calls.find(([req]) => req.method === 'POST' && req.path === '/sessions')?.[0];
    expect(request?.body).toMatchObject({ title: '16.09.2026, 14:35' });
  });

  it('requires spoken languages before capture or session creation', async () => {
    useStore.setState({ settings: { ...settings, used_languages: null } });
    await useStore.getState().startRecording();
    expect(bridge.openNative).not.toHaveBeenCalled();
    expect(bridge.request).not.toHaveBeenCalled();
    expect(useStore.getState().recorderState).toBe('idle');
    expect(useStore.getState().recorderError).toMatch(/используемые языки/i);
  });
  it('waits for an in-flight open on Quit and never starts late capture', async () => {
    let resolveOpen!: () => void;
    const open = vi.mocked(bridge.openNative).getMockImplementation()!;
    vi.mocked(bridge.openNative).mockImplementation((id, rate) => new Promise((resolve) => {
      resolveOpen = () => { void open(id, rate).then(resolve); };
    }));
    const starting = useStore.getState().startRecording();
    await vi.waitFor(() => expect(resolveOpen).toBeTypeOf('function'));
    const quitting = useStore.getState().prepareForQuit();
    expect(bridge.endNative).not.toHaveBeenCalled();
    resolveOpen();
    await starting;
    await expect(quitting).resolves.toBe(true);
    expect(bridge.endNative).toHaveBeenCalledExactlyOnceWith('native-test', 'stop');
    expect(bridge.sendNativeAudio).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(useStore.getState().recorderState).toBe('stopped');
  });

  it('removes the failure listener after durable Stop and ignores late transport events', async () => {
    const unsubscribe = vi.fn();
    let failure!: Parameters<BridgeApi['onNativeFailure']>[0];
    vi.mocked(bridge.onNativeFailure).mockImplementation((callback) => {
      failure = callback;
      return unsubscribe;
    });
    await useStore.getState().startRecording();
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    await stopping;
    expect(unsubscribe).toHaveBeenCalledOnce();
    failure({ sessionId: 'native-test', code: 'native_stream_failed' });
    expect(useStore.getState().recorderError).toBeNull();
    await expect(useStore.getState().prepareForQuit()).resolves.toBe(true);
  });

  it('keeps failed native finalization retryable for the original session', async () => {
    await useStore.getState().startRecording();
    vi.mocked(bridge.endNative).mockResolvedValueOnce({ ok: false, status: 503, detail: 'end failed' });
    const pausing = useStore.getState().pauseRecording();
    releaseBarrier();
    await pausing;
    expect(useStore.getState().recorderState).toBe('paused');
    expect(useStore.getState().pendingSessionStatus).toBe('paused');
    useStore.setState({ activeSessionId: 'other' });
    await useStore.getState().retrySessionStatus();
    expect(bridge.openNative).toHaveBeenLastCalledWith('native-test', 16000);
    expect(bridge.endNative).toHaveBeenLastCalledWith('native-test', 'pause');
    expect(useStore.getState().pendingSessionStatus).toBeNull();
    expect(useStore.getState().recorderState).toBe('paused');
  });

  it('finalizes only once when Stop is repeated during a capture barrier', async () => {
    await useStore.getState().startRecording();
    const first = useStore.getState().stopRecording();
    const second = useStore.getState().stopRecording();
    releaseBarrier();
    await Promise.all([first, second]);
    expect(bridge.endNative).toHaveBeenCalledExactlyOnceWith('native-test', 'stop');
    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'PATCH' }));
    expect(useStore.getState().pendingSessionStatus).toBeNull();
  });

  it('does not resurrect capture when Stop overtakes Resume opening', async () => {
    await useStore.getState().startRecording();
    const pausing = useStore.getState().pauseRecording();
    releaseBarrier();
    await pausing;
    let resolveOpen!: () => void;
    const open = vi.mocked(bridge.openNative).getMockImplementation()!;
    vi.mocked(bridge.openNative).mockImplementation((id, rate) => new Promise((resolve) => {
      resolveOpen = () => { void open(id, rate).then(resolve); };
    }));
    const resuming = useStore.getState().resumeRecording();
    await vi.waitFor(() => expect(resolveOpen).toBeTypeOf('function'));
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    resolveOpen();
    await Promise.all([resuming, stopping]);
    expect(useStore.getState().recorderState).toBe('stopped');
    expect(bridge.endNative).toHaveBeenLastCalledWith('native-test', 'stop');
    expect(useStore.getState().pendingSessionStatus).toBeNull();
  });

  it('releases the transport listener when opening fails before capture begins', async () => {
    const unsubscribe = vi.fn();
    vi.mocked(bridge.onNativeFailure).mockReturnValue(unsubscribe);
    vi.mocked(bridge.openNative).mockResolvedValueOnce({ ok: false, status: 503, detail: 'open failed' });
    await useStore.getState().startRecording();
    expect(trackStop).toHaveBeenCalled();
    expect(useStore.getState().recorderState).toBe('idle');
    expect(useStore.getState().recorderError).toMatch(/open failed/);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(bridge.sendNativeAudio).not.toHaveBeenCalled();
  });

  it('closes an opened transport when browser capture setup fails', async () => {
    vi.stubGlobal('AudioWorkletNode', class { constructor() { throw new Error('worklet failed'); } });
    await useStore.getState().startRecording();
    expect(trackStop).toHaveBeenCalled();
    expect(bridge.endNative).toHaveBeenCalledExactlyOnceWith('native-test', 'stop');
    expect(useStore.getState().recorderError).toMatch(/worklet failed/);
    expect(useStore.getState().pendingSessionStatus).toBeNull();
  });

  it('blocks Quit on failed Stop, then retries the original session without new capture', async () => {
    await useStore.getState().startRecording();
    vi.mocked(bridge.endNative).mockResolvedValueOnce({ ok: false, status: 503, detail: 'end failed' });
    const quitting = useStore.getState().prepareForQuit();
    releaseBarrier();
    await expect(quitting).resolves.toBe(false);
    expect(useStore.getState().pendingSessionStatus).toBe('stopped');
    useStore.getState().cancelQuit();
    useStore.setState({ activeSessionId: 'other' });
    await useStore.getState().retrySessionStatus();
    expect(bridge.endNative).toHaveBeenLastCalledWith('native-test', 'stop');
    expect(useStore.getState().pendingSessionStatus).toBeNull();
    await expect(useStore.getState().prepareForQuit()).resolves.toBe(true);
  });

  it('reports an incompatible archived recording instead of silently creating a different session', async () => {
    useStore.setState({
      activeSessionId: 'archive', sessions: [{ ...session, id: 'archive', duration_ms: 1000 }],
      nextRecordingMode: 'contextual_local',
      detail: { segments: [{ id: 'old', start_ms: 0, end_ms: 1000, text: 'archive' }], messages: [], notes: null },
    });
    vi.mocked(bridge.openNative).mockResolvedValueOnce({ ok: false, status: 409, detail: 'Existing file recording cannot become a native stream.' });
    await useStore.getState().startRecording();
    expect(useStore.getState().activeSessionId).toBe('archive');
    expect(useStore.getState().recorderError).toMatch(/cannot become a native stream/);
    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/sessions' }));
    expect(bridge.openNative).toHaveBeenCalledWith('archive', 16000);
    expect(bridge.storeAudio).not.toHaveBeenCalled();
    expect(bridge.uploadAudio).not.toHaveBeenCalled();
    expect(bridge.fetchAudio).not.toHaveBeenCalled();
    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringContaining('/asr/live/advance') }));
  });

  it.each(['pause', 'stop'] as const)('blocks new sessions and Record throughout %s capture drain', async (action) => {
    await useStore.getState().startRecording();
    const draining = action === 'pause' ? useStore.getState().pauseRecording() : useStore.getState().stopRecording();
    expect(useStore.getState().recorderState).toBe('processing');
    await useStore.getState().newSession();
    await useStore.getState().startRecording();
    expect(vi.mocked(bridge.request).mock.calls.filter(([req]) => req.path === '/sessions' && req.method === 'POST')).toHaveLength(1);
    releaseBarrier();
    await draining;
    expect(useStore.getState().recorderState).toBe(action === 'pause' ? 'paused' : 'stopped');
  });

  it('does not resurrect Pause when Stop overtakes its capture drain', async () => {
    await useStore.getState().startRecording();
    const pausing = useStore.getState().pauseRecording();
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    await Promise.all([pausing, stopping]);
    expect(useStore.getState().recorderState).toBe('stopped');
    expect(bridge.endNative).toHaveBeenCalledExactlyOnceWith('native-test', 'stop');
  });

  it('finishes the recording session captured before a selection change during Pause', async () => {
    await useStore.getState().startRecording();
    const pausing = useStore.getState().pauseRecording();
    useStore.setState({ activeSessionId: 'other' });
    releaseBarrier();
    await pausing;
    expect(bridge.endNative).toHaveBeenCalledExactlyOnceWith('native-test', 'pause');
    expect(useStore.getState().activeSessionId).toBe('other');
  });

  it('waits for durable tail persistence before sending native Stop', async () => {
    await useStore.getState().startRecording();
    let releaseSave!: () => void;
    const send = vi.mocked(bridge.sendNativeAudio).getMockImplementation()!;
    vi.mocked(bridge.sendNativeAudio).mockImplementation((id, meta, pcm) => new Promise((resolve) => {
      releaseSave = () => { void send(id, meta, pcm).then(resolve); };
    }));
    const stopping = useStore.getState().stopRecording();
    deliver(new Float32Array(16).fill(1));
    releaseBarrier();
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf('function'));
    expect(useStore.getState().recorderState).toBe('processing');
    expect(bridge.endNative).not.toHaveBeenCalled();
    releaseSave();
    await stopping;
    expect(saved).toBe(16);
    expect(bridge.endNative).toHaveBeenCalledExactlyOnceWith('native-test', 'stop');
  });

  it('keeps Record blocked after a successful Quit save until cancellation', async () => {
    await useStore.getState().startRecording();
    const quitting = useStore.getState().prepareForQuit();
    releaseBarrier();
    await expect(quitting).resolves.toBe(true);
    await useStore.getState().startRecording();
    expect(bridge.openNative).toHaveBeenCalledTimes(1);
    useStore.getState().cancelQuit();
    await useStore.getState().startRecording();
    expect(bridge.openNative).toHaveBeenCalledTimes(2);
  });

  it('keeps incomplete capture sticky across repeated Quit and a later recording', async () => {
    await useStore.getState().startRecording();
    vi.useFakeTimers();
    try {
      const quitting = useStore.getState().prepareForQuit();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(quitting).resolves.toBe(false);
    } finally { vi.useRealTimers(); }
    releaseBarrier();
    await expect(useStore.getState().prepareForQuit()).resolves.toBe(false);
    useStore.getState().cancelQuit();
    await useStore.getState().startRecording();
    const quitting = useStore.getState().prepareForQuit();
    releaseBarrier();
    await expect(quitting).resolves.toBe(false);
  });

  it('publishes capture signal diagnostics and clears them on Stop', async () => {
    await useStore.getState().startRecording();
    deliver(new Float32Array(1600).fill(1));
    expect(useStore.getState().meter).toMatchObject({ clipping: true, vad: 'unavailable', dbfs: 0 });
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    await stopping;
    expect(useStore.getState().meter.clipping).toBe(false);
    expect(useStore.getState().meter.dbfs).toBe(-60);
  });

  it.each([false, true])('serializes delayed Pause ACK before newer failed Stop (retry=%s)', async (retry) => {
    await useStore.getState().startRecording();
    if (retry) {
      vi.mocked(bridge.endNative).mockResolvedValueOnce({ ok: false, status: 503, detail: 'pause failed' });
      const pausing = useStore.getState().pauseRecording();
      releaseBarrier();
      await pausing;
      expect(useStore.getState().pendingSessionStatus).toBe('paused');
    }
    let releasePause!: () => void;
    const end = vi.mocked(bridge.endNative).getMockImplementation()!;
    vi.mocked(bridge.endNative).mockImplementation((id, action) => new Promise((resolve) => {
      releasePause = () => { void end(id, action).then(resolve); };
    }));
    const previous = vi.mocked(bridge.request).getMockImplementation()!;
    vi.mocked(bridge.request).mockImplementation(async (req) => req.method === 'PATCH'
      ? { ok: false, status: 503, detail: 'newer stop failed' } : previous(req));
    const pausing = retry ? useStore.getState().retrySessionStatus() : useStore.getState().pauseRecording();
    if (!retry) releaseBarrier();
    await vi.waitFor(() => expect(releasePause).toBeTypeOf('function'));
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'PATCH' }));
    releasePause();
    await Promise.all([pausing, stopping]);
    expect(useStore.getState().pendingSessionStatus).toBe('stopped');
    expect(useStore.getState().pendingSessionStatusSessionId).toBe('native-test');
    expect(useStore.getState().recorderError).toMatch(/newer stop failed/);
    expect(useStore.getState().recorderState).toBe('stopped');
  });

  it('never installs a late transcript read into another selected session', async () => {
    let releaseRead!: () => void;
    const previous = vi.mocked(bridge.request).getMockImplementation()!;
    vi.mocked(bridge.request).mockImplementation(async (req) => {
      if (req.method === 'GET' && req.path === '/sessions/native-test') {
        return new Promise((resolve) => { releaseRead = () => resolve({ ok: true, status: 200, data: {
          session, segments: [{ id: 'late', start_ms: 0, end_ms: 100, text: 'old transcript' }], messages: [], notes: null,
        } }); });
      }
      if (req.method === 'GET' && req.path === '/sessions/other') return { ok: true, status: 200, data: {
        session: { ...session, id: 'other' }, segments: [], messages: [], notes: null,
      } };
      return previous(req);
    });
    const loading = useStore.getState().selectSession('native-test');
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    await useStore.getState().selectSession('other');
    releaseRead();
    await loading;
    expect(useStore.getState().activeSessionId).toBe('other');
    expect(useStore.getState().detail?.segments).toEqual([]);
  });

  it('keeps recording through a one-second delivery stall and then drains in order', async () => {
    await useStore.getState().startRecording();
    const send = vi.mocked(bridge.sendNativeAudio).getMockImplementation()!;
    let release!: () => void;
    vi.mocked(bridge.sendNativeAudio).mockImplementationOnce((id, meta, pcm) => new Promise((resolve) => {
      release = () => { void send(id, meta, pcm).then(resolve); };
    }));
    for (let i = 0; i < 10; i++) deliver(new Float32Array(1600).fill(0.1));
    expect(useStore.getState().recorderState).toBe('recording');
    expect(useStore.getState().queue.overflow).toBe(false);
    expect(trackStop).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(useStore.getState().queue.pending).toBe(0));
    expect(saved).toBe(16000);
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    await stopping;
  });

  it('retains unsaved PCM after storage refusal and sends it only on explicit retry', async () => {
    await useStore.getState().startRecording();
    vi.mocked(bridge.sendNativeAudio).mockResolvedValueOnce({ ok: false, status: 503, detail: 'disk refused' });
    deliver(new Float32Array(1600).fill(1));
    await vi.waitFor(() => expect(useStore.getState().queue.failed).toHaveLength(1));
    releaseBarrier();
    await vi.waitFor(() => expect(trackStop).toHaveBeenCalled());
    expect(saved).toBe(0);
    expect(useStore.getState().recorderError).toMatch(/delivery is interrupted/);
    expect(useStore.getState().recorderState).toBe('processing');
    useStore.getState().retryFailedUploads();
    await vi.waitFor(() => expect(useStore.getState().recorderState).toBe('stopped'));
    expect(saved).toBe(1600);
    expect(bridge.sendNativeAudio).toHaveBeenCalledTimes(2);
    expect(useStore.getState().queue.failed).toEqual([]);
    expect(useStore.getState().recorderError).toBeNull();
  });

  it('reopens on Resume without resetting the sample clock', async () => {
    await useStore.getState().startRecording();
    deliver(new Float32Array(1600).fill(1));
    const pausing = useStore.getState().pauseRecording();
    releaseBarrier();
    await pausing;
    expect(bridge.endNative).toHaveBeenCalledWith('native-test', 'pause');
    await useStore.getState().resumeRecording();
    expect(bridge.openNative).toHaveBeenCalledTimes(2);
    deliver(new Float32Array(1600).fill(-1));
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    await stopping;
    expect(saved).toBe(3200);
    expect(sequence).toBe(2);
    expect(useStore.getState().pendingSessionStatus).toBeNull();
  });

  it('protects PCM after a lost ACK and reconciles only on explicit retry', async () => {
    await useStore.getState().startRecording();
    loseAck = true;
    deliver(new Float32Array(1600).fill(1));
    await vi.waitFor(() => expect(useStore.getState().queue.failed).toHaveLength(1));
    releaseBarrier();
    await vi.waitFor(() => expect(trackStop).toHaveBeenCalled());
    expect(bridge.openNative).toHaveBeenCalledTimes(1);
    expect(useStore.getState().queue.pending).toBe(1);
    useStore.getState().retryFailedUploads();
    await vi.waitFor(() => expect(useStore.getState().recorderState).toBe('stopped'));
    expect(bridge.openNative).toHaveBeenCalledTimes(2);
    expect(bridge.sendNativeAudio).toHaveBeenCalledTimes(1);
    expect(useStore.getState().queue.pending).toBe(0);
    await expect(useStore.getState().prepareForQuit()).resolves.toBe(true);
  });

  it('uses the durable native Stop ACK even if a subsequent session refresh fails', async () => {
    await useStore.getState().startRecording();
    vi.mocked(bridge.request).mockResolvedValue({ ok: false, status: 503, detail: 'refresh unavailable' });
    const stopping = useStore.getState().stopRecording();
    releaseBarrier();
    await stopping;
    expect(bridge.endNative).toHaveBeenCalledExactlyOnceWith('native-test', 'stop');
    expect(useStore.getState().pendingSessionStatus).toBeNull();
    expect(useStore.getState().recorderState).toBe('stopped');
    await expect(useStore.getState().prepareForQuit()).resolves.toBe(true);
  });

  it('saves 100ms PCM before Stop and finalizes the exact capture tail before Quit', async () => {
    await useStore.getState().startRecording();
    expect(bridge.openNative).toHaveBeenCalledWith('native-test', 16000);
    deliver(new Float32Array(1600).fill(1));
    await vi.waitFor(() => expect(saved).toBe(1600));
    const quitting = useStore.getState().prepareForQuit();
    expect(trackStop).toHaveBeenCalled();
    expect(bridge.endNative).not.toHaveBeenCalled();
    deliver(new Float32Array(16).fill(-1));
    releaseBarrier();
    await expect(quitting).resolves.toBe(true);
    expect(saved).toBe(1616);
    expect(bridge.endNative).toHaveBeenCalledExactlyOnceWith('native-test', 'stop');
    expect(bridge.storeAudio).not.toHaveBeenCalled();
    expect(bridge.uploadAudio).not.toHaveBeenCalled();
  });
});
