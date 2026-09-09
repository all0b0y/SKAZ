import { describe, it, expect, vi } from 'vitest';
import { UploadQueue, type AudioChunk, type Uploader } from './uploadQueue';

const chunk = (sequence: number): AudioChunk => ({
  sequence,
  startMs: sequence * 5000,
  endMs: (sequence + 1) * 5000,
  wav: new ArrayBuffer(8),
});

const instantSleep = () => Promise.resolve();

const ok: Uploader = async () => ({ duplicate: false, segments: [] });

describe('UploadQueue ordering and completion', () => {
  it('uploads chunks sequentially in enqueue order', async () => {
    const seen: number[] = [];
    const uploader: Uploader = async (c) => {
      seen.push(c.sequence);
      return { duplicate: false, segments: [] };
    };
    const q = new UploadQueue({ uploader, sleep: instantSleep });
    q.enqueue(chunk(0));
    q.enqueue(chunk(1));
    q.enqueue(chunk(2));
    await q.drain();
    expect(seen).toEqual([0, 1, 2]);
    expect(q.getState().completed).toBe(3);
    expect(q.getState().pending).toBe(0);
  });

  it('never runs two uploads concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const uploader: Uploader = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { duplicate: false, segments: [] };
    };
    const q = new UploadQueue({ uploader, sleep: instantSleep });
    q.enqueue(chunk(0));
    q.enqueue(chunk(1));
    q.enqueue(chunk(2));
    await q.drain();
    expect(maxActive).toBe(1);
  });

  it('counts backend-reported duplicates without losing them', async () => {
    const uploader: Uploader = async (c) => ({ duplicate: c.sequence === 1, segments: [] });
    const q = new UploadQueue({ uploader, sleep: instantSleep });
    q.enqueue(chunk(0));
    q.enqueue(chunk(1));
    await q.drain();
    expect(q.getState().completed).toBe(2);
    expect(q.getState().duplicates).toBe(1);
  });
});

describe('UploadQueue retry semantics', () => {
  it('retries a failing chunk and preserves ordering on eventual success', async () => {
    const seen: number[] = [];
    let attempts0 = 0;
    const uploader: Uploader = async (c) => {
      if (c.sequence === 0) {
        attempts0 += 1;
        if (attempts0 < 3) throw new Error('network');
      }
      seen.push(c.sequence);
      return { duplicate: false, segments: [] };
    };
    const q = new UploadQueue({ uploader, sleep: instantSleep, maxAttempts: 5 });
    q.enqueue(chunk(0));
    q.enqueue(chunk(1));
    await q.drain();
    expect(seen).toEqual([0, 1]); // 0 still delivered before 1
    expect(attempts0).toBe(3);
    expect(q.getState().completed).toBe(2);
    expect(q.getState().failed).toHaveLength(0);
  });

  it('moves a chunk to failed (retained, visible) after exhausting attempts', async () => {
    const uploader: Uploader = async (c) => {
      if (c.sequence === 0) throw new Error('boom');
      return { duplicate: false, segments: [] };
    };
    const q = new UploadQueue({ uploader, sleep: instantSleep, maxAttempts: 2 });
    q.enqueue(chunk(0));
    q.enqueue(chunk(1));
    await q.drain();
    const state = q.getState();
    expect(state.failed).toHaveLength(1);
    expect(state.failed[0]!.sequence).toBe(0);
    expect(state.failed[0]!.attempts).toBe(2);
    expect(state.failed[0]!.error).toContain('boom');
    expect(state.completed).toBe(1); // chunk 1 still delivered
    expect(state.lastError).toContain('boom');
  });

  it('re-enqueues failed chunks on retryFailed and can succeed', async () => {
    let fail = true;
    const uploader: Uploader = async () => {
      if (fail) throw new Error('temporary');
      return { duplicate: false, segments: [] };
    };
    const q = new UploadQueue({ uploader, sleep: instantSleep, maxAttempts: 1 });
    q.enqueue(chunk(0));
    await q.drain();
    expect(q.getState().failed).toHaveLength(1);

    fail = false;
    q.retryFailed();
    await q.drain();
    expect(q.getState().failed).toHaveLength(0);
    expect(q.getState().completed).toBe(1);
  });
});

describe('UploadQueue bounded backpressure', () => {
  it('protects the exact overflow chunk for retry and requests capture pause', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const uploaded: AudioChunk[] = [];
    const uploader: Uploader = async (value) => {
      await gate;
      uploaded.push(value);
      return { duplicate: false, segments: [] };
    };
    const onBackpressure = vi.fn();
    const q = new UploadQueue({ uploader, sleep: instantSleep, maxPending: 2, onBackpressure });
    expect(q.enqueue(chunk(0))).toBe(true); // becomes in-flight
    expect(q.enqueue(chunk(1))).toBe(true); // queued
    const protectedChunk = chunk(2);
    expect(q.enqueue(protectedChunk)).toBe(false); // protected outside live queue
    const state = q.getState();
    expect(state.overflow).toBe(true);
    expect(state.droppedCount).toBe(0);
    expect(state.failed).toEqual([
      expect.objectContaining({ sequence: 2, error: expect.stringMatching(/paused|protected/i) }),
    ]);
    expect(onBackpressure).toHaveBeenCalledTimes(1);
    release();
    await q.drain();

    q.retryFailed();
    await q.drain();
    // The protected overflow chunk survives with its exact bytes + metadata and
    // is delivered on retry. It arrives after the in-order backlog (c0, c1),
    // preserving the queue's ordering guarantee, so assert by containment.
    expect(uploaded).toContainEqual(protectedChunk);
  });

  it('retries an exhausted upload with its original metadata and WAV bytes', async () => {
    const original = chunk(7);
    const seen: AudioChunk[] = [];
    let fail = true;
    const q = new UploadQueue({
      maxAttempts: 1,
      sleep: instantSleep,
      uploader: async (value) => {
        seen.push(value);
        if (fail) throw new Error('offline');
        return { duplicate: false, segments: [] };
      },
    });
    q.enqueue(original);
    await q.drain();
    fail = false;
    q.retryFailed();
    await q.drain();
    expect(seen).toEqual([original, original]);
  });

  it('accepts again once the queue drains below the bound', async () => {
    const q = new UploadQueue({ uploader: ok, sleep: instantSleep, maxPending: 1 });
    q.enqueue(chunk(0));
    await q.drain();
    expect(q.enqueue(chunk(1))).toBe(true);
    await q.drain();
    expect(q.getState().completed).toBe(2);
  });
});

describe('UploadQueue observability', () => {
  it('notifies onChange with pending count for backlog display', async () => {
    const states: number[] = [];
    const q = new UploadQueue({
      uploader: ok,
      sleep: instantSleep,
      onChange: (s) => states.push(s.pending),
    });
    q.enqueue(chunk(0));
    q.enqueue(chunk(1));
    await q.drain();
    expect(Math.max(...states)).toBeGreaterThan(0);
    expect(q.getState().pending).toBe(0);
  });

  it('drain resolves immediately when the queue is idle', async () => {
    const q = new UploadQueue({ uploader: ok, sleep: instantSleep });
    await expect(q.drain()).resolves.toBeUndefined();
  });

  it('applies backoff between retries via the injected sleep', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let n = 0;
    const uploader: Uploader = async () => {
      n += 1;
      if (n < 3) throw new Error('x');
      return { duplicate: false, segments: [] };
    };
    const q = new UploadQueue({ uploader, sleep, maxAttempts: 5, backoffMs: (a) => a * 100 });
    q.enqueue(chunk(0));
    await q.drain();
    expect(sleep).toHaveBeenCalledWith(100);
    expect(sleep).toHaveBeenCalledWith(200);
  });
});
