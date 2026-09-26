import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest } from '../api/bridge';
import type { Settings } from '../api/types';

// External browser and IPC boundaries only; production store, recorder and writer.
// This checks which sources are opened and what the user is told — not real audio.
let releaseBarrier: () => void;
const session = { id: 'sys-test', title: 'Sys', created_at: '', status: 'stopped' as const, duration_ms: 0, mode: 'legacy' as const };
const baseSettings: Settings = {
  used_languages: ['en'],
  asr: { provider: 'local-whisper', model: 'small' }, agent: { provider: 'openrouter', model: 'a' },
  notes: { provider: 'openrouter', model: 'n' }, transcript_language: 'auto', output_language: 'en',
  cloud_consent: false, contextual_local_enabled: false, input_device_id: null, capture_system_audio: true,
};
interface Track { kind: string; readyState: string; stop: () => void; addEventListener: (t: string, f: () => void) => void; end: () => void }
const makeTrack = (kind = 'audio'): Track => {
  const fns: (() => void)[] = [];
  const t: Track = { kind, readyState: 'live', stop: vi.fn(() => { t.readyState = 'ended'; }),
    addEventListener: (_x, f) => { fns.push(f); }, end: () => { t.readyState = 'ended'; fns.forEach((f) => f()); } };
  return t;
};
const asStream = (t: Track) => ({ getTracks: () => [t], getAudioTracks: () => [t], getVideoTracks: () => [] });
let getDisplayMedia: ReturnType<typeof vi.fn>;
let mics: Track[];
let loopbacks: Track[];
let bridge: BridgeApi;
let useStore: (typeof import('./store'))['useStore'];

beforeEach(async () => {
  vi.resetModules();
  mics = []; loopbacks = [];
  class Context {
    sampleRate = 16000; state = 'running';
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  class Worklet {
    port = { onmessage: null as null | ((e: { data: unknown }) => void),
      postMessage: (data: unknown) => { releaseBarrier = () => this.port.onmessage?.({ data }); }, close() {} };
    disconnect() {}
  }
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  getDisplayMedia = vi.fn(async () => { const t = makeTrack(); loopbacks.push(t); return asStream(t); });
  vi.stubGlobal('navigator', { mediaDevices: {
    getUserMedia: vi.fn(async () => { const t = makeTrack(); mics.push(t); return asStream(t); }),
    getDisplayMedia, enumerateDevices: async () => [],
  } });
  bridge = {
    ...window.audiohelper,
    request: vi.fn(async (req: BridgeRequest) => {
      if (req.path === '/sessions/sys-test' && req.method === 'GET') return { ok: true, status: 200, data: { session, segments: [], messages: [], notes: null } };
      if (req.path === '/sessions/sys-test' && req.method === 'PATCH') return { ok: true, status: 200, data: session };
      if (req.path === '/sessions' && req.method === 'GET') return { ok: true, status: 200, data: { sessions: [session] } };
      return { ok: false, status: 404, detail: 'not found' };
    }) as BridgeApi['request'],
    openNative: vi.fn<BridgeApi['openNative']>(async (_id, rate) => ({ ok: true, status: 200, data: {
      connection_id: 'c', sample_rate: rate, saved_samples: 0, next_sequence: 0, transcription: 'connecting' } })),
    sendNativeAudio: vi.fn<BridgeApi['sendNativeAudio']>(async (_id, meta) => ({ ok: true, status: 200, data: { sequence: meta.sequence, saved_samples: 0, duplicate: false } })),
    endNative: vi.fn<BridgeApi['endNative']>(async (_id, action) => ({ ok: true, status: 200, data: {
      saved_samples: 0, status: action === 'pause' ? 'paused' : 'stopped', transcription_complete: false } })),
    onNativeFailure: vi.fn(() => () => {}),
  };
  window.audiohelper = bridge;
  useStore = (await import('./store')).useStore;
  useStore.setState({ settings: baseSettings, ready: true, activeSessionId: session.id, sessions: [session] });
});
afterEach(async () => {
  if (['recording', 'paused', 'processing'].includes(useStore.getState().recorderState)) {
    const stopped = useStore.getState().stopRecording();
    releaseBarrier?.();
    await stopped;
  }
  vi.unstubAllGlobals();
});

const pause = async () => {
  const pausing = useStore.getState().pauseRecording();
  await vi.waitFor(() => expect(releaseBarrier).toBeTypeOf('function'));
  releaseBarrier();
  await pausing;
};

describe('system audio recording lifecycle', () => {
  it('records microphone and system audio when the setting is on', async () => {
    await useStore.getState().startRecording();
    expect(useStore.getState().recorderState).toBe('recording');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(useStore.getState().systemAudioIssue).toBeNull();
  });

  it('does not start when system audio is refused, then records mic only on request without changing the setting', async () => {
    getDisplayMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); });
    await useStore.getState().startRecording();
    expect(useStore.getState().recorderState).toBe('idle');
    expect(useStore.getState().systemAudioIssue).toEqual({ phase: 'start', reason: 'denied' });
    expect(useStore.getState().recorderError).toMatch(/System Settings/);
    expect(bridge.openNative).not.toHaveBeenCalled();
    expect(mics.every((t) => t.readyState === 'ended')).toBe(true);

    await useStore.getState().startRecording({ micOnly: true });
    expect(useStore.getState().recorderState).toBe('recording');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(useStore.getState().systemAudioIssue).toBeNull();
    expect(useStore.getState().settings?.capture_system_audio).toBe(true);
  });

  it('keeps recording the microphone when system audio ends mid-recording', async () => {
    await useStore.getState().startRecording();
    loopbacks[0]!.end();
    expect(useStore.getState().recorderState).toBe('recording');
    expect(useStore.getState().systemAudioIssue).toEqual({ phase: 'lost', reason: 'ended' });
    expect(useStore.getState().recorderError).toBe('System audio stopped — recording microphone only.');
    expect(mics[0]!.readyState).toBe('live');
  });

  it('adds system audio on Resume after it was turned on while paused', async () => {
    useStore.setState({ settings: { ...baseSettings, capture_system_audio: false } });
    await useStore.getState().startRecording();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    await pause();
    useStore.setState({ settings: { ...baseSettings, capture_system_audio: true } });
    await useStore.getState().resumeRecording();
    expect(useStore.getState().recorderState).toBe('recording');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('stays paused with the error when system audio is refused on Resume', async () => {
    useStore.setState({ settings: { ...baseSettings, capture_system_audio: false } });
    await useStore.getState().startRecording();
    await pause();
    useStore.setState({ settings: { ...baseSettings, capture_system_audio: true } });
    getDisplayMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); });
    const opens = vi.mocked(bridge.openNative).mock.calls.length;
    await useStore.getState().resumeRecording();
    expect(useStore.getState().recorderState).toBe('paused');
    expect(useStore.getState().systemAudioIssue).toEqual({ phase: 'resume', reason: 'denied' });
    expect(vi.mocked(bridge.openNative).mock.calls.length).toBe(opens);
    await useStore.getState().resumeRecording({ micOnly: true });
    expect(useStore.getState().recorderState).toBe('recording');
  });
});
