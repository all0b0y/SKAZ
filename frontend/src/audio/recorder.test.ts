import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioRecorder, type RecordedChunk } from './recorder';

// Browser boundary simulation only: this verifies PCM preservation, not real ASR.
class TestWorklet {
  static current: TestWorklet;
  port = {
    onmessage: null as null | ((event: { data: Float32Array | { type: 'barrier'; id: number } }) => void),
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  disconnect = vi.fn();
  constructor() { TestWorklet.current = this; }
  frame(values: number[]) { this.port.onmessage?.({ data: new Float32Array(values) }); }
  acknowledge() {
    const request = this.port.postMessage.mock.calls.at(-1)?.[0];
    if (!request) throw new Error('No barrier requested');
    this.port.onmessage?.({ data: request });
  }
}
const trackStop = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const getUserMedia = vi.fn();
class TestContext {
  sampleRate = 1000;
  state = 'running';
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource() { return { connect, disconnect }; }
  async close() { this.state = 'closed'; }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('AudioContext', TestContext);
  vi.stubGlobal('AudioWorkletNode', TestWorklet);
  getUserMedia.mockResolvedValue({
    getTracks: () => [{ stop: trackStop }],
    getAudioTracks: () => [{ addEventListener: vi.fn(), stop: trackStop }],
  });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
});
afterEach(() => vi.unstubAllGlobals());

function samples(chunk: RecordedChunk): number[] {
  const view = new DataView(chunk.wav);
  return Array.from({ length: (chunk.wav.byteLength - 44) / 2 }, (_, i) => view.getInt16(44 + i * 2, true));
}

describe('microphone capture drain', () => {
  it('waits for native readiness and emits 100ms windows without losing the pause tail', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const onReady = vi.fn(() => ready);
    const chunks: RecordedChunk[] = [];
    const recorder = new AudioRecorder({ onReady, onChunk: (chunk) => { chunks.push(chunk); } }, { windowSeconds: 0.1 });
    const starting = recorder.start();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith(1000));
    expect(connect).not.toHaveBeenCalled();
    release();
    await starting;
    TestWorklet.current.frame(Array(150).fill(0.5));
    expect(chunks).toHaveLength(1);
    expect(samples(chunks[0]!)).toHaveLength(100);
    const pausing = recorder.pause();
    TestWorklet.current.frame([1]);
    TestWorklet.current.acknowledge();
    await pausing;
    expect(samples(chunks[1]!)).toHaveLength(51);
    expect(recorder.elapsedMs()).toBe(151);
  });

  it('does not begin capture after Stop while permission is still pending', async () => {
    let grant!: (stream: unknown) => void;
    getUserMedia.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const recorder = new AudioRecorder({ onChunk: () => undefined });
    const starting = recorder.start();
    const rejected = expect(starting).rejects.toThrow('cancelled');
    await recorder.stop();
    grant({ getTracks: () => [{ stop: trackStop }], getAudioTracks: () => [] });
    await rejected;
    expect(trackStop).toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(recorder.state).toBe('stopped');
  });
  it('reports unamplified signal level and disables implicit microphone gain', async () => {
    const onLevel = vi.fn();
    const recorder = new AudioRecorder({ onChunk: () => undefined, onLevel });
    await recorder.start();
    TestWorklet.current.frame(Array(1000).fill(0.1));
    expect(onLevel.mock.calls.at(-1)?.[0]).toBeCloseTo(0.1, 5);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  });

  it('delivers raw per-frame rms/peak via onSignal for the level meter to aggregate', async () => {
    const onSignal = vi.fn();
    const recorder = new AudioRecorder({ onChunk: () => undefined, onSignal });
    await recorder.start();
    TestWorklet.current.frame([0.1, -0.5, 0.2]);
    expect(onSignal).toHaveBeenCalledTimes(1);
    const sample = onSignal.mock.calls[0]![0];
    expect(sample.peak).toBeCloseTo(0.5, 5); // real per-frame peak, not the rms
    expect(sample.rms).toBeGreaterThan(0);
    expect(sample.rms).toBeLessThan(sample.peak);
    expect(sample.sampleCount).toBe(3);
    expect(sample.sampleRate).toBe(1_000);
  });

  it('stops the microphone immediately and shares an in-progress pause drain', async () => {
    const chunks: RecordedChunk[] = [];
    const recorder = new AudioRecorder({ onChunk: (chunk) => { chunks.push(chunk); } });
    await recorder.start();
    const worklet = TestWorklet.current;
    worklet.frame([1]);
    const pausing = recorder.pause();
    const stopping = recorder.stop();
    const stoppingAgain = recorder.stop();
    expect(trackStop).toHaveBeenCalled();
    expect(worklet.port.postMessage).toHaveBeenCalledTimes(1);
    worklet.frame([-1]);
    worklet.acknowledge();
    await Promise.all([pausing, stopping, stoppingAgain]);
    expect(recorder.state).toBe('stopped');
    expect(chunks).toHaveLength(1);
    expect(samples(chunks[0]!)).toEqual([32767, -32768]);
    expect(worklet.port.close).toHaveBeenCalledTimes(1);
  });

  it.each(['pause', 'stop'] as const)('preserves frames already in flight when %s begins', async (operation) => {
    const chunks: RecordedChunk[] = [];
    const recorder = new AudioRecorder({ onChunk: (chunk) => { chunks.push(chunk); } });
    await recorder.start();
    const worklet = TestWorklet.current;
    worklet.frame([0, 1]);
    const finishing = recorder[operation]();
    worklet.frame([-1]); // captured before the worklet acknowledges its barrier
    worklet.acknowledge();
    await finishing;
    expect(chunks).toHaveLength(1);
    expect(samples(chunks[0]!)).toEqual([0, 32767, -32768]);
    expect(chunks[0]).toMatchObject({ sequence: 0, startMs: 0, endMs: 3 });
    expect(recorder.elapsedMs()).toBe(3);
    worklet.frame([1]);
    expect(recorder.elapsedMs()).toBe(3);
  });

  it('ignores frames delivered after capture has fully stopped and torn down', async () => {
    const onChunk = vi.fn();
    const recorder = new AudioRecorder({ onChunk });
    await recorder.start();
    const worklet = TestWorklet.current;
    worklet.frame([1, 2]);
    const stopping = recorder.stop();
    worklet.acknowledge();
    await stopping;
    onChunk.mockClear();

    worklet.frame([3, 4, 5]); // arrives well after the barrier; the worklet is torn down
    expect(onChunk).not.toHaveBeenCalled();
    expect(recorder.state).toBe('stopped');
  });

  it('is idempotent when stop is called again after capture has already stopped', async () => {
    const chunks: RecordedChunk[] = [];
    const recorder = new AudioRecorder({ onChunk: (chunk) => { chunks.push(chunk); } });
    await recorder.start();
    const worklet = TestWorklet.current;
    worklet.frame([1]);
    const stopping = recorder.stop();
    worklet.acknowledge();
    await stopping;
    expect(chunks).toHaveLength(1);

    await recorder.stop(); // second, sequential call after already stopped
    expect(worklet.port.postMessage).toHaveBeenCalledTimes(1); // no new barrier
    expect(worklet.port.close).toHaveBeenCalledTimes(1); // no repeated teardown
    expect(chunks).toHaveLength(1); // no duplicate/empty chunk emitted
    expect(recorder.state).toBe('stopped');
  });

  it.each(['pause', 'stop'] as const)('marks incomplete capture and releases the microphone after %s barrier timeout', async (operation) => {
    vi.useFakeTimers();
    try {
      const chunks: RecordedChunk[] = [];
      const onError = vi.fn();
      const onCaptureIncomplete = vi.fn();
      const recorder = new AudioRecorder({ onChunk: (chunk) => { chunks.push(chunk); }, onError, onCaptureIncomplete });
      await recorder.start();
      const worklet = TestWorklet.current;
      worklet.frame([1]);
      const finishing = recorder[operation]();
      await vi.advanceTimersByTimeAsync(2_001);
      await finishing;
      expect(onCaptureIncomplete).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.stringMatching(/capture completeness is unknown/i));
      expect(recorder.state).toBe('stopped');
      expect(trackStop).toHaveBeenCalled();
      expect(samples(chunks[0]!)).toEqual([32767]);
      worklet.acknowledge(); // a late ACK cannot restore confidence or resume capture
      await recorder.resume();
      await recorder.stop();
      worklet.frame([-1]);
      expect(recorder.state).toBe('stopped');
      expect(chunks).toHaveLength(1);
      expect(onCaptureIncomplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
