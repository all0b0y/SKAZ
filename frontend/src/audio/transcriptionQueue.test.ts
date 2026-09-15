import { describe, expect, it, vi } from 'vitest';
import { TranscriptionQueue, type AudioDescriptor } from './transcriptionQueue';

const descriptor = (sequence: number): AudioDescriptor => ({
  sessionId: 's1',
  sequence,
  startMs: sequence * 100,
  endMs: sequence * 100 + 100,
});

describe('TranscriptionQueue descriptor-only scheduling', () => {
  it('materializes at most one stored WAV and does not delay later persistence ACKs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const materialize = vi.fn(async (item: AudioDescriptor) => new Uint8Array([item.sequence]).buffer);
    const transcribe = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { duplicate: true, segments: [] };
    });
    const queue = new TranscriptionQueue({ materialize, transcribe });
    queue.enqueue(descriptor(0));
    queue.enqueue(descriptor(1));
    expect(queue.retainedRawCount()).toBe(0);
    expect(materialize).toHaveBeenCalledTimes(1);
    release();
    await queue.drain();
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('does not automatically retry a failed paid request and retries only explicitly', async () => {
    let fail = true;
    const transcribe = vi.fn(async () => {
      if (fail) throw new Error('provider 502');
      return { duplicate: true, segments: [] };
    });
    const queue = new TranscriptionQueue({
      materialize: async () => new ArrayBuffer(4),
      transcribe,
    });
    queue.enqueue(descriptor(2));
    await queue.drain();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(queue.getState().failed).toEqual([expect.objectContaining({ sequence: 2 })]);
    await Promise.resolve();
    expect(transcribe).toHaveBeenCalledTimes(1);

    fail = false;
    queue.retryFailed();
    await queue.drain();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(queue.getState().failed).toEqual([]);
  });

  it('continues with later descriptors after an ASR failure', async () => {
    const seen: number[] = [];
    const queue = new TranscriptionQueue({
      materialize: async () => new ArrayBuffer(4),
      transcribe: async (item) => {
        seen.push(item.sequence);
        if (item.sequence === 0) throw new Error('provider failed');
        return { duplicate: true, segments: [] };
      },
    });
    queue.enqueue(descriptor(0));
    queue.enqueue(descriptor(1));
    await queue.drain();
    expect(seen).toEqual([0, 1]);
    expect(queue.getState()).toMatchObject({ completed: 1, failed: [expect.objectContaining({ sequence: 0 })] });
  });

  it('never materializes or transcribes while cloud consent is absent', async () => {
    const materialize = vi.fn(async () => new ArrayBuffer(4));
    const transcribe = vi.fn(async () => ({ duplicate: true, segments: [] }));
    const queue = new TranscriptionQueue({ materialize, transcribe, canTranscribe: () => false });
    queue.enqueue(descriptor(0));
    await Promise.resolve();
    expect(materialize).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(queue.getState()).toMatchObject({ blockedByConsent: true, pending: 1 });
  });

  it('rechecks consent after materializing and before the outbound upload', async () => {
    let consent = true;
    let release!: () => void;
    const materialized = new Promise<void>((resolve) => { release = resolve; });
    const transcribe = vi.fn(async () => ({ duplicate: true, segments: [] }));
    const queue = new TranscriptionQueue({
      canTranscribe: () => consent,
      materialize: async () => {
        await materialized;
        return new ArrayBuffer(4);
      },
      transcribe,
    });

    queue.enqueue(descriptor(0));
    consent = false;
    release();
    await queue.drain();

    expect(transcribe).not.toHaveBeenCalled();
    expect(queue.getState()).toMatchObject({ blockedByConsent: true, pending: 1, failed: [] });
    expect(queue.hasSequence(descriptor(0))).toBe(true);

    consent = true;
    queue.resume();
    await queue.drain();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('bounds descriptors and reports disk-backed deferred work without retaining WAV bytes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = new TranscriptionQueue({
      maxPending: 1,
      materialize: async () => new ArrayBuffer(4),
      transcribe: async () => { await gate; return { duplicate: true, segments: [] }; },
    });
    expect(queue.enqueue(descriptor(0))).toBe(true);
    expect(queue.enqueue(descriptor(1))).toBe(false);
    expect(queue.getState().deferred).toBe(1);
    expect(queue.retainedRawCount()).toBe(0);
    release();
    await queue.drain();
  });

  it('ignores duplicate scheduling while a sequence is queued, active, or failed', async () => {
    const queue = new TranscriptionQueue({
      materialize: async () => new ArrayBuffer(4),
      transcribe: async () => { throw new Error('failed'); },
    });
    expect(queue.enqueue(descriptor(7))).toBe(true);
    expect(queue.enqueue(descriptor(7))).toBe(true);
    await queue.drain();
    expect(queue.getState().failed).toHaveLength(1);
    expect(queue.enqueue(descriptor(7))).toBe(true);
    expect(queue.getState().failed).toHaveLength(1);
  });

  it('does not confuse the same sequence number from different sessions', async () => {
    const seen: string[] = [];
    const queue = new TranscriptionQueue({
      materialize: async () => new ArrayBuffer(4),
      transcribe: async (item) => {
        seen.push(item.sessionId);
        return { duplicate: true, segments: [] };
      },
    });
    queue.enqueue({ ...descriptor(0), sessionId: 'a' });
    queue.enqueue({ ...descriptor(0), sessionId: 'b' });
    await queue.drain();
    expect(seen).toEqual(['a', 'b']);
  });

  it('blocks new batches at the failure cap and reopens only on explicit retry', async () => {
    let fail = true;
    const transcribe = vi.fn(async () => {
      if (fail) throw new Error('provider failed');
      return { duplicate: true, segments: [] };
    });
    const queue = new TranscriptionQueue({
      maxPending: 2,
      materialize: async () => new ArrayBuffer(4),
      transcribe,
    });

    queue.enqueue(descriptor(0));
    await queue.drain();
    queue.enqueue(descriptor(1));
    await queue.drain();
    for (let sequence = 2; sequence < 102; sequence += 1) {
      expect(queue.enqueue(descriptor(sequence))).toBe(false);
      expect(queue.hasSequence(descriptor(sequence))).toBe(false);
      await Promise.resolve();
    }

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(queue.getState()).toMatchObject({ pending: 0, deferred: 100 });
    expect(queue.getState().failed).toHaveLength(2);

    queue.resume();
    await Promise.resolve();
    expect(transcribe).toHaveBeenCalledTimes(2);

    fail = false;
    queue.retryFailed();
    await queue.drain();
    expect(transcribe).toHaveBeenCalledTimes(4);
    expect(queue.getState().failed).toEqual([]);
    expect(queue.enqueue(descriptor(102))).toBe(true);
    await queue.drain();
    expect(transcribe).toHaveBeenCalledTimes(5);
  });
});
