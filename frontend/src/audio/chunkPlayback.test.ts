import { describe, expect, it, vi } from 'vitest';
import { ChunkPlaybackController, findChunkForSegment, findChunksForSegment, getContextBounds } from './chunkPlayback';
import type { AudioChunkManifest } from '../api/types';
import { encodeWavPcm16Mono } from './wav';

const syntheticPcmWav = () => encodeWavPcm16Mono(new Float32Array([0, 0.25, -0.25, 0]), 8_000);

class FakeAudio {
  src = '';
  currentTime = 0;
  paused = true;
  readyState = 1;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(name: string, listener: () => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
  }
  removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
  emit(name: string) { for (const listener of this.listeners.get(name) ?? []) listener(); }
}

const chunks: AudioChunkManifest[] = [
  { sequence: 10, start_ms: 0, end_ms: 1_000, status: 'done', available: true, segment_ids: [], source_kind: 'original_captured_wav' },
  { sequence: 20, start_ms: 1_000, end_ms: 2_000, status: 'failed', available: true, segment_ids: ['segment-real'], source_kind: 'original_captured_wav' },
  { sequence: 30, start_ms: 2_000, end_ms: 3_000, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' },
];

const setup = (items = chunks) => {
  const audio = new FakeAudio();
  const fetchAudio = vi.fn(async () => syntheticPcmWav());
  const createObjectURL = vi.fn((_: Blob) => `blob:${createObjectURL.mock.calls.length}`);
  const revokeObjectURL = vi.fn();
  const states: unknown[] = [];
  const controller = new ChunkPlaybackController({
    sessionId: 's1', chunks: items, audio, fetchAudio, createObjectURL, revokeObjectURL,
    onState: (state) => states.push(state),
  });
  return { audio, fetchAudio, createObjectURL, revokeObjectURL, states, controller };
};

describe('chunk playback mapping', () => {
  it('uses actual manifest segment_ids and computes bounded context', () => {
    expect(findChunkForSegment(chunks, 'segment-real')?.sequence).toBe(20);
    expect(findChunkForSegment(chunks, '20')).toBeUndefined();
    expect(getContextBounds(chunks, 20)).toEqual({ startIndex: 0, endIndex: 2 });
    expect(getContextBounds(chunks, 10)).toEqual({ startIndex: 0, endIndex: 1 });
  });

  it('maps a new final to every associated source chunk without changing legacy one-chunk mapping', () => {
    const linked = chunks.map((chunk) => ({
      ...chunk,
      segment_ids: chunk.sequence === 10 || chunk.sequence === 20 ? ['multi'] : chunk.segment_ids,
    }));
    expect(findChunksForSegment(linked, 'multi').map((chunk) => chunk.sequence)).toEqual([10, 20]);
    expect(findChunksForSegment(chunks, 'segment-real').map((chunk) => chunk.sequence)).toEqual([20]);
  });

  it('plays every source of a multi-chunk final and respects its exact transcript bounds', async () => {
    const linked = chunks.map((chunk) => ({
      ...chunk,
      segment_ids: chunk.sequence === 10 || chunk.sequence === 20 ? ['multi'] : chunk.segment_ids,
    }));
    const { controller, audio, fetchAudio, states } = setup(linked);
    await controller.playSegment('multi', false, { startMs: 250, endMs: 1_750 });
    expect(fetchAudio).toHaveBeenCalledWith('s1', 10);
    expect(audio.currentTime).toBe(0.25);
    audio.emit('ended');
    await vi.waitFor(() => expect(fetchAudio).toHaveBeenCalledWith('s1', 20));
    audio.currentTime = 0.75;
    audio.emit('timeupdate');
    expect(states.at(-1)).toMatchObject({ playing: false, timelineMs: 1_750 });
  });

  it('does not silently play a partial draft source list', async () => {
    const { controller, fetchAudio, states } = setup();
    await controller.playSequences([10, 999]);
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ error: expect.stringMatching(/missing/i) });
  });

  it('plays a cited chunk whole, then stops at its source boundary', async () => {
    const { controller, audio, fetchAudio } = setup();
    await controller.playSegment('segment-real', false);
    expect(fetchAudio).toHaveBeenCalledWith('s1', 20);
    expect(audio.currentTime).toBe(0);
    audio.emit('ended');
    await Promise.resolve();
    expect(audio.pause).toHaveBeenCalled();
    expect(fetchAudio).not.toHaveBeenCalledWith('s1', 30);
  });

  it('plays adjacent stored chunks with visible context bounds and advances on ended', async () => {
    const { controller, audio, fetchAudio, states } = setup();
    await controller.playSegment('segment-real', true);
    expect(states.at(-1)).toMatchObject({ mode: 'context', contextStartSequence: 10, contextEndSequence: 30, selectedSequence: 10 });
    audio.emit('ended');
    await vi.waitFor(() => expect(fetchAudio).toHaveBeenCalledWith('s1', 20));
  });

  it('reports timeline gaps and missing files without synthesizing or skipping them', async () => {
    const gap = [chunks[0]!, { ...chunks[2]!, start_ms: 2_500, available: false }];
    const { controller, audio, fetchAudio, states } = setup(gap);
    await controller.seek(1_500);
    expect(states.at(-1)).toMatchObject({ error: expect.stringMatching(/gap/i) });
    expect(audio.play).not.toHaveBeenCalled();
    await controller.playFull();
    audio.emit('ended');
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ error: expect.stringMatching(/gap/i) }));
    expect(fetchAudio).not.toHaveBeenCalledWith('s1', 30);
  });

  it('ignores late bytes after destroy and revokes every created Blob URL', async () => {
    let resolve!: (bytes: ArrayBuffer) => void;
    const audio = new FakeAudio();
    const createObjectURL = vi.fn(() => 'blob:late');
    const revokeObjectURL = vi.fn();
    const controller = new ChunkPlaybackController({
      sessionId: 's1', chunks, audio,
      fetchAudio: vi.fn(() => new Promise<ArrayBuffer>((done) => { resolve = done; })),
      createObjectURL, revokeObjectURL, onState: vi.fn(),
    });
    const playing = controller.playFull();
    controller.destroy();
    resolve(syntheticPcmWav());
    await playing;
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();

    const loaded = setup();
    await loaded.controller.playFull();
    loaded.controller.destroy();
    expect(loaded.revokeObjectURL).toHaveBeenCalledWith(expect.stringMatching(/^blob:/));
  });

  it('keeps only the current chunk and one small lookahead cached', async () => {
    const { controller, audio, createObjectURL, revokeObjectURL } = setup();
    await controller.playFull();
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    audio.emit('ended');
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(3));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes the same audio element without fetching again', async () => {
    const { controller, audio, fetchAudio } = setup();
    await controller.playFull();
    const calls = fetchAudio.mock.calls.length;
    controller.pause();
    await controller.resume();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(fetchAudio).toHaveBeenCalledTimes(calls);
  });

  it('does not interrupt the current chunk when bounded lookahead fails', async () => {
    const audio = new FakeAudio();
    const states: unknown[] = [];
    const controller = new ChunkPlaybackController({
      sessionId: 's1', chunks, audio,
      fetchAudio: vi.fn(async (_id, sequence) => {
        if (sequence === 20) throw new Error('synthetic preload failure');
        return syntheticPcmWav();
      }),
      createObjectURL: vi.fn(() => 'blob:current'),
      revokeObjectURL: vi.fn(),
      onState: (state) => states.push(state),
    });
    await controller.playFull();
    await Promise.resolve();
    expect(audio.pause).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ playing: true, error: null });
  });

  it('preserves active playback across status changes and appended manifest chunks', async () => {
    const { controller, audio, fetchAudio, revokeObjectURL, states } = setup();
    await controller.playSegment('segment-real', false);
    const activeSrc = audio.src;
    audio.currentTime = 0.4;

    controller.updateChunks([
      chunks[0]!,
      { ...chunks[1]!, status: 'done' },
      chunks[2]!,
      { sequence: 40, start_ms: 3_000, end_ms: 4_000, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' },
    ]);

    expect(audio.src).toBe(activeSrc);
    expect(audio.currentTime).toBe(0.4);
    expect(audio.paused).toBe(false);
    expect(fetchAudio).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ playing: true, selectedSequence: 20 });
  });

  it('keeps exact context bounds fixed when live manifest polling appends a chunk', async () => {
    const { controller, audio, fetchAudio, states } = setup();
    await controller.playSegment('segment-real', true);
    controller.updateChunks([
      ...chunks,
      { sequence: 40, start_ms: 3_000, end_ms: 4_000, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' },
    ]);
    audio.emit('ended');
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ selectedSequence: 20, playing: true }));
    audio.emit('ended');
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ selectedSequence: 30, playing: true }));
    audio.emit('ended');
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ playing: false }));
    expect(fetchAudio).not.toHaveBeenCalledWith('s1', 40);
    expect(states.at(-1)).toMatchObject({ contextStartSequence: 10, contextEndSequence: 30 });
  });

  it('ignores an old ended event while a newer source is loading', async () => {
    let resolveThirty!: (bytes: ArrayBuffer) => void;
    const audio = new FakeAudio();
    const states: unknown[] = [];
    const controller = new ChunkPlaybackController({
      sessionId: 's1', chunks: [
        { ...chunks[0]!, segment_ids: ['segment-ten'] },
        { ...chunks[2]!, segment_ids: ['segment-thirty'] },
      ], audio,
      fetchAudio: vi.fn(async (_id, sequence) => sequence === 30
        ? new Promise<ArrayBuffer>((resolve) => { resolveThirty = resolve; })
        : syntheticPcmWav()),
      createObjectURL: vi.fn((blob: Blob) => `blob:${blob.size}:${Date.now()}`),
      revokeObjectURL: vi.fn(), onState: (state) => states.push(state),
    });
    await controller.playSegment('segment-ten', false);
    audio.pause.mockClear();
    const newer = controller.playSegment('segment-thirty', false);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    audio.emit('ended');
    expect(audio.pause).toHaveBeenCalledTimes(1);
    resolveThirty(syntheticPcmWav());
    await newer;
    expect(states.at(-1)).toMatchObject({ selectedSequence: 30, playing: true, error: null });
  });

  it('does not let a stale load failure stop newer successful playback', async () => {
    let rejectTen!: (reason: Error) => void;
    const audio = new FakeAudio();
    const states: unknown[] = [];
    const items = [
      { ...chunks[0]!, segment_ids: ['segment-ten'] },
      { ...chunks[1]!, segment_ids: ['segment-twenty'] },
    ];
    const controller = new ChunkPlaybackController({
      sessionId: 's1', chunks: items, audio,
      fetchAudio: vi.fn(async (_id, sequence) => sequence === 10
        ? new Promise<ArrayBuffer>((_resolve, reject) => { rejectTen = reject; })
        : syntheticPcmWav()),
      createObjectURL: vi.fn(() => 'blob:new'), revokeObjectURL: vi.fn(),
      onState: (state) => states.push(state),
    });
    const stale = controller.playSegment('segment-ten', false);
    await controller.playSegment('segment-twenty', false);
    rejectTen(new Error('late synthetic failure'));
    await stale;
    expect(audio.src).toBe('blob:new');
    expect(audio.paused).toBe(false);
    expect(states.at(-1)).toMatchObject({ selectedSequence: 20, playing: true, error: null });
  });

  it('does not let late lookahead evict the active Blob of a newer run', async () => {
    let resolveLookahead!: (bytes: ArrayBuffer) => void;
    const audio = new FakeAudio();
    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn((_: Blob) => `blob:${createObjectURL.mock.calls.length}`);
    const controller = new ChunkPlaybackController({
      sessionId: 's1', chunks, audio,
      fetchAudio: vi.fn(async (_id, sequence) => sequence === 20
        ? new Promise<ArrayBuffer>((resolve) => { resolveLookahead = resolve; })
        : syntheticPcmWav()),
      createObjectURL, revokeObjectURL, onState: vi.fn(),
    });
    await controller.playFull();
    await controller.seek(2_500);
    const activeSrc = audio.src;
    resolveLookahead(syntheticPcmWav());
    await Promise.resolve();
    expect(audio.src).toBe(activeSrc);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(activeSrc);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('waits for metadata before applying a seek offset and reports decoder errors', async () => {
    const audio = new FakeAudio();
    audio.readyState = 0;
    const states: unknown[] = [];
    const controller = new ChunkPlaybackController({
      sessionId: 's1', chunks, audio, fetchAudio: vi.fn(async () => syntheticPcmWav()),
      createObjectURL: vi.fn(() => 'blob:metadata'), revokeObjectURL: vi.fn(),
      onState: (state) => states.push(state),
    });
    const seeking = controller.seek(500);
    await Promise.resolve();
    expect(audio.currentTime).toBe(0);
    audio.readyState = 1;
    audio.emit('loadedmetadata');
    await seeking;
    expect(audio.currentTime).toBe(0.5);
    audio.emit('error');
    expect(states.at(-1)).toMatchObject({ playing: false, error: expect.stringMatching(/decode|play/i) });
  });
});
