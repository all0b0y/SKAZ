import type { Segment } from '../api/types';

// Sequential, bounded, retrying upload queue for recorded audio windows.
//
// Guarantees (see docs/ARCHITECTURE.md and docs/API.md):
//  - one upload in flight at a time, processed in enqueue (sequence) order;
//  - failing chunks retry in place with backoff so ordering is preserved;
//  - a chunk that exhausts its attempts is retained in `failed`, never dropped
//    silently, and can be retried by the user;
//  - the live queue is bounded: the first chunk beyond the bound is moved to a
//    recoverable holding slot and capture is paused before another window;
//  - `drain()` resolves once nothing is pending, so stop/pause can flush the
//    tail before tearing the recorder down.

export interface AudioChunk {
  sequence: number;
  startMs: number;
  endMs: number;
  wav: ArrayBuffer;
}

export interface UploadResult {
  duplicate: boolean;
  segments: Segment[];
}

export type Uploader = (chunk: AudioChunk) => Promise<UploadResult>;

export interface FailedChunk {
  sequence: number;
  error: string;
  attempts: number;
}

export interface UploadQueueState {
  /** waiting + in-flight chunks not yet completed or failed */
  pending: number;
  /** sequence currently uploading, or null when idle */
  inFlight: number | null;
  /** chunks the backend accepted (including acknowledged duplicates) */
  completed: number;
  /** subset of completed the backend reported as duplicates */
  duplicates: number;
  /** chunks that exhausted retries; retained and user-retryable */
  failed: FailedChunk[];
  /** chunks rejected because the queue was over its bound */
  droppedCount: number;
  overflow: boolean;
  lastError: string | null;
}

export interface UploadQueueOptions {
  uploader: Uploader;
  maxPending?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
  onChange?: (state: UploadQueueState) => void;
  onBackpressure?: () => void;
}

const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BACKOFF_CAP_MS = 8000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultBackoff = (attempt: number): number =>
  Math.min(DEFAULT_BACKOFF_CAP_MS, 250 * 2 ** (attempt - 1));

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

interface QueueItem {
  chunk: AudioChunk;
  attempts: number;
}

export class UploadQueue {
  private readonly uploader: Uploader;
  private readonly maxPending: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: (attempt: number) => number;
  private readonly onChange?: (state: UploadQueueState) => void;
  private readonly onBackpressure?: () => void;

  private readonly queue: QueueItem[] = [];
  private inFlight: number | null = null;
  private completed = 0;
  private duplicates = 0;
  private droppedCount = 0;
  private overflow = false;
  private lastError: string | null = null;
  private readonly failedItems: Array<QueueItem & { error: string }> = [];

  private processing = false;
  private drainWaiters: Array<() => void> = [];

  constructor(options: UploadQueueOptions) {
    this.uploader = options.uploader;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.sleep = options.sleep ?? defaultSleep;
    this.backoffMs = options.backoffMs ?? defaultBackoff;
    this.onChange = options.onChange;
    this.onBackpressure = options.onBackpressure;
  }

  /** Number of chunks waiting or in flight. */
  private pendingCount(): number {
    return this.queue.length + (this.inFlight === null ? 0 : 1);
  }

  getState(): UploadQueueState {
    return {
      pending: this.pendingCount(),
      inFlight: this.inFlight,
      completed: this.completed,
      duplicates: this.duplicates,
      failed: this.failedItems.map((f) => ({
        sequence: f.chunk.sequence,
        error: f.error,
        attempts: f.attempts,
      })),
      droppedCount: this.droppedCount,
      overflow: this.overflow,
      lastError: this.lastError,
    };
  }

  private emit(): void {
    this.onChange?.(this.getState());
  }

  /**
   * Enqueue a chunk. Returns false when capture must pause. The rejected live
   * chunk is retained byte-for-byte for retry, so backpressure never discards
   * captured audio.
   */
  enqueue(chunk: AudioChunk): boolean {
    if (this.pendingCount() >= this.maxPending) {
      this.overflow = true;
      const message = `Upload backlog full (${this.maxPending}); recording paused and audio protected for retry`;
      this.lastError = message;
      this.failedItems.push({ chunk, attempts: 0, error: message });
      this.emit();
      this.onBackpressure?.();
      return false;
    }
    this.queue.push({ chunk, attempts: 0 });
    this.emit();
    void this.run();
    return true;
  }

  /** Re-enqueue every chunk that previously exhausted its retries. */
  retryFailed(): void {
    if (this.failedItems.length === 0) return;
    const items = this.failedItems.splice(0, this.failedItems.length);
    for (const f of items) {
      this.queue.push({ chunk: f.chunk, attempts: 0 });
    }
    this.emit();
    void this.run();
  }

  /** Resolve once the queue is idle (all chunks completed or failed). */
  drain(): Promise<void> {
    if (!this.processing && this.pendingCount() === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private settleDrainWaiters(): void {
    if (this.pendingCount() === 0 && !this.processing) {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async run(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.inFlight = item.chunk.sequence;
      this.emit();

      let delivered = false;
      while (!delivered) {
        item.attempts += 1;
        try {
          const result = await this.uploader(item.chunk);
          this.completed += 1;
          if (result.duplicate) this.duplicates += 1;
          delivered = true;
        } catch (err) {
          const message = errorMessage(err);
          this.lastError = message;
          if (item.attempts >= this.maxAttempts) {
            this.failedItems.push({
              chunk: item.chunk,
              error: message,
              attempts: item.attempts,
            });
            break; // give up on this chunk; retained in `failed`
          }
          this.emit();
          await this.sleep(this.backoffMs(item.attempts));
        }
      }

      this.inFlight = null;
      this.emit();
    }

    this.processing = false;
    this.emit();
    this.settleDrainWaiters();
  }
}
