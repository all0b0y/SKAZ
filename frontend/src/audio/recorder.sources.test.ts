import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioRecorder, SystemAudioUnavailable } from './recorder';

// Browser boundary simulation: verifies which streams are opened, mixed and
// released. Real loopback audio is verified by the Electron spike, not here.
class TestWorklet {
  static current: TestWorklet;
  port = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: vi.fn(), close: vi.fn() };
  disconnect = vi.fn();
  constructor() { TestWorklet.current = this; }
  acknowledge() {
    const request = this.port.postMessage.mock.calls.at(-1)?.[0];
    this.port.onmessage?.({ data: request });
  }
}

interface FakeTrack { kind: string; readyState: string; stop: ReturnType<typeof vi.fn>; fire: () => void; addEventListener: (t: string, f: () => void) => void }
const track = (kind: string, readyState = 'live'): FakeTrack => {
  const listeners: (() => void)[] = [];
  const t: FakeTrack = {
    kind, readyState, stop: vi.fn(() => { t.readyState = 'ended'; }),
    addEventListener: (_type, fn) => { listeners.push(fn); },
    fire: () => { t.readyState = 'ended'; listeners.forEach((fn) => fn()); },
  };
  return t;
};
const stream = (...tracks: FakeTrack[]) => ({
  getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
});

const sources: { stream: unknown; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
class TestContext {
  sampleRate = 1000;
  state = 'running';
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource(s: unknown) {
    const node = { stream: s, connect: vi.fn(), disconnect: vi.fn() };
    sources.push(node);
    return node;
  }
  async close() { this.state = 'closed'; }
}

const getUserMedia = vi.fn();
const getDisplayMedia = vi.fn();
let mic: FakeTrack;
let loopback: FakeTrack;

beforeEach(() => {
  vi.clearAllMocks();
  sources.length = 0;
  mic = track('audio');
  loopback = track('audio');
  vi.stubGlobal('AudioContext', TestContext);
  vi.stubGlobal('AudioWorkletNode', TestWorklet);
  getUserMedia.mockImplementation(async () => stream(mic));
  getDisplayMedia.mockImplementation(async () => stream(loopback));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, getDisplayMedia } });
});
afterEach(() => vi.unstubAllGlobals());

const pause = async (recorder: AudioRecorder) => {
  const pausing = recorder.pause();
  TestWorklet.current.acknowledge();
  await pausing;
};

describe('capture sources', () => {
  it('opens only the microphone unless system audio is asked for', async () => {
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    await recorder.start({ deviceId: 'usb' });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'usb' } }) });
    expect(sources).toHaveLength(1);
  });

  it('mixes system audio into the same capture and never keeps a video track', async () => {
    const video = track('video');
    getDisplayMedia.mockResolvedValueOnce(stream(loopback, video));
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    await recorder.start({ systemAudio: true });
    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false,
    });
    expect(video.stop).toHaveBeenCalled();
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.connect.mock.calls[0]?.[0] === TestWorklet.current)).toBe(true);
    expect(recorder.systemAudioActive).toBe(true);
  });

  it('falls back to the default microphone when the saved one is missing', async () => {
    getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' }); });
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    await recorder.start({ deviceId: 'airpods' });
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    expect(recorder.state).toBe('recording');
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['NotSupportedError', 'unsupported'],
    ['AbortError', 'failed'],
  ])('does not start at all when system audio fails with %s', async (name, reason) => {
    getDisplayMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('x'), { name }); });
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    const error = await recorder.start({ systemAudio: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SystemAudioUnavailable);
    expect((error as SystemAudioUnavailable).reason).toBe(reason);
    expect(mic.stop).toHaveBeenCalled();
    expect(recorder.state).toBe('idle');
  });

  it('treats an already-ended loopback track as unavailable', async () => {
    getDisplayMedia.mockResolvedValueOnce(stream(track('audio', 'ended')));
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    await expect(recorder.start({ systemAudio: true })).rejects.toMatchObject({ reason: 'failed' });
  });

  it('keeps recording the microphone when system audio ends mid-recording', async () => {
    const onSystemAudioLost = vi.fn();
    const onDisconnected = vi.fn();
    const recorder = new AudioRecorder({ onChunk: () => undefined, onSystemAudioLost, onDisconnected });
    await recorder.start({ systemAudio: true });
    const systemNode = sources[1]!;
    loopback.fire();
    expect(onSystemAudioLost).toHaveBeenCalledTimes(1);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(systemNode.disconnect).toHaveBeenCalled();
    expect(recorder.state).toBe('recording');
    expect(recorder.systemAudioActive).toBe(false);
  });

  it('switches the microphone and adds system audio while paused, then resumes on the same timeline', async () => {
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    await recorder.start({ deviceId: 'built-in' });
    const firstMic = mic;
    await pause(recorder);
    mic = track('audio');
    await recorder.changeSources({ deviceId: 'usb', systemAudio: true });
    expect(firstMic.stop).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'usb' } }) });
    expect(recorder.state).toBe('paused');
    await recorder.resume();
    expect(recorder.state).toBe('recording');
    const live = sources.filter((s) => s.connect.mock.calls.length > 0 && s.disconnect.mock.calls.length === 0);
    expect(live.map((s) => s.stream)).toHaveLength(2);
  });

  it('drops system audio while paused and keeps the old sources if a change fails', async () => {
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    await recorder.start({ systemAudio: true });
    await pause(recorder);
    await recorder.changeSources({ systemAudio: false });
    expect(loopback.stop).toHaveBeenCalled();
    expect(recorder.systemAudioActive).toBe(false);
    getDisplayMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); });
    await expect(recorder.changeSources({ systemAudio: true })).rejects.toBeInstanceOf(SystemAudioUnavailable);
    expect(recorder.state).toBe('paused');
    expect(mic.stop).not.toHaveBeenCalled();
  });

  it('refuses to change sources while recording', async () => {
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    await recorder.start({});
    await expect(recorder.changeSources({ systemAudio: true })).rejects.toThrow(/while recording/);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('releases every source on stop', async () => {
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    await recorder.start({ systemAudio: true });
    const stopping = recorder.stop();
    TestWorklet.current.acknowledge();
    await stopping;
    expect(mic.stop).toHaveBeenCalled();
    expect(loopback.stop).toHaveBeenCalled();
  });
});
