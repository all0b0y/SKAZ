import { describe, expect, it, vi } from 'vitest';
import { PersistenceQueue, type PersistedAudioAck } from './persistenceQueue';
import type { AudioChunk } from './uploadQueue';

const chunk = (sequence: number, bytes = [sequence, 0, sequence + 1]): AudioChunk => ({
  sequence,
  startMs: sequence * 10,
  endMs: sequence * 10 + 10,
  wav: new Uint8Array(bytes).buffer,
});

const ack = (sequence: number, duplicate = false): PersistedAudioAck => ({
  sequence,
  start_ms: sequence * 10,
  end_ms: sequence * 10 + 10,
  status: 'pending',
  available: true,
  duplicate,
  source_kind: 'original_captured_wav',
});

describe('PersistenceQueue durable FIFO', () => {
  it('stores exact WAV bytes in sequence order and releases them only after ACK', async () => {
    const seen: Array<{ sequence: number; bytes: number[] }> = [];
    const stored = vi.fn();
    const queue = new PersistenceQueue({
      store: async (item) => {
        seen.push({ sequence: item.sequence, bytes: [...new Uint8Array(item.wav)] });
        return ack(item.sequence);
      },
      onStored: stored,
    });
    queue.enqueue(chunk(0, [82, 73, 70, 70, 0, 0])); // silence bytes stay bytes
    queue.enqueue(chunk(1, [0, 0, 0, 0]));
    await expect(queue.drain()).resolves.toBe(true);
    expect(seen).toEqual([
      { sequence: 0, bytes: [82, 73, 70, 70, 0, 0] },
      { sequence: 1, bytes: [0, 0, 0, 0] },
    ]);
    expect(stored).toHaveBeenCalledTimes(2);
    expect(queue.retainedRawCount()).toBe(0);
  });

  it('accepts an idempotent duplicate ACK as durably stored', async () => {
    const onStored = vi.fn();
    const queue = new PersistenceQueue({ store: async (item) => ack(item.sequence, true), onStored });
    queue.enqueue(chunk(4));
    await expect(queue.drain()).resolves.toBe(true);
    expect(queue.getState()).toMatchObject({ completed: 1, duplicates: 1, failed: [] });
    expect(onStored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duplicate: true }));
  });

  it('does not release bytes when storage ACK readback mismatches the captured chunk', async () => {
    const queue = new PersistenceQueue({
      maxAttempts: 1,
      store: async (item) => ({ ...ack(item.sequence), end_ms: item.endMs + 1 }),
    });
    queue.enqueue(chunk(3));
    await expect(queue.drain()).resolves.toBe(false);
    expect(queue.retainedRawCount()).toBe(1);
    expect(queue.getState().lastError).toMatch(/ack/i);
  });

  it('blocks FIFO on storage failure, retains a bounded exact backlog, and succeeds on explicit retry', async () => {
    let fail = true;
    const stopCapture = vi.fn();
    const seen: number[][] = [];
    const queue = new PersistenceQueue({
      maxAttempts: 1,
      maxPending: 2,
      store: async (item) => {
        seen.push([...new Uint8Array(item.wav)]);
        if (fail) throw new Error('disk full');
        return ack(item.sequence);
      },
      onBlocked: stopCapture,
    });
    const first = chunk(0, [0, 0, 0]);
    const second = chunk(1, [1, 0, 1]);
    expect(queue.enqueue(first)).toBe(true);
    expect(queue.enqueue(second)).toBe(true);
    await expect(queue.drain()).resolves.toBe(false);
    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(queue.getState().failed).toEqual([expect.objectContaining({ sequence: 0 })]);
    expect(queue.retainedRawCount()).toBe(2);

    fail = false;
    queue.retryFailed();
    await expect(queue.drain()).resolves.toBe(true);
    expect(seen).toEqual([[0, 0, 0], [0, 0, 0], [1, 0, 1]]);
    expect(queue.retainedRawCount()).toBe(0);
  });

  it('signals backpressure and retains the one just-captured overflow chunk for retry', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onBlocked = vi.fn();
    const queue = new PersistenceQueue({
      maxPending: 1,
      store: async (item) => { await gate; return ack(item.sequence); },
      onBlocked,
    });
    expect(queue.enqueue(chunk(0))).toBe(true);
    expect(queue.enqueue(chunk(1))).toBe(false);
    expect(queue.enqueue(chunk(2))).toBe(false); // protected stop-tail slot
    expect(queue.retainedRawCount()).toBe(3); // bounded live slot + overflow + stop tail
    expect(queue.getState()).toMatchObject({ overflow: true, droppedCount: 0 });
    expect(onBlocked).toHaveBeenCalledTimes(1);
    release();
    queue.retryFailed();
    await expect(queue.drain()).resolves.toBe(true);
    expect(queue.retainedRawCount()).toBe(0);
  });
});

it('drains accepted transient PCM without requiring an audio file', async () => {
  const store = vi.fn(async (value: AudioChunk) => ({ sequence: value.sequence,
    start_ms: value.startMs, end_ms: value.endMs, status: 'pending' as const,
    available: false, duplicate: false, source_kind: 'transient_pcm' as const }));
  const queue = new PersistenceQueue({ store });
  queue.enqueue(chunk(0));
  expect(await queue.drain()).toBe(true);
  expect(queue.getState().completed).toBe(1);
});
