import type { AudioChunk } from './uploadQueue';

export interface PersistedAudioAck {
  sequence: number;
  start_ms: number;
  end_ms: number;
  status: 'pending' | 'failed' | 'done';
  available: boolean;
  duplicate: boolean;
  source_kind: 'original_captured_wav';
}

export interface PersistenceFailure {
  sequence: number;
  error: string;
  attempts: number;
}

export interface PersistenceQueueState {
  pending: number;
  inFlight: number | null;
  completed: number;
  duplicates: number;
  failed: PersistenceFailure[];
  droppedCount: number;
  overflow: boolean;
  lastError: string | null;
}

interface QueueItem {
  chunk: AudioChunk;
  attempts: number;
}

export interface PersistenceQueueOptions {
  store: (chunk: AudioChunk) => Promise<PersistedAudioAck>;
  maxPending?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
  onStored?: (chunk: AudioChunk, ack: PersistedAudioAck) => void;
  onChange?: (state: PersistenceQueueState) => void;
  onBlocked?: () => void;
}

const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_ATTEMPTS = 4;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number): number => Math.min(8_000, 250 * 2 ** (attempt - 1));
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function validateAck(chunk: AudioChunk, ack: PersistedAudioAck): void {
  if (
    ack.sequence !== chunk.sequence ||
    ack.start_ms !== chunk.startMs ||
    ack.end_ms !== chunk.endMs ||
    ack.available !== true ||
    ack.source_kind !== 'original_captured_wav'
  ) {
    throw new Error(`Invalid local storage ACK for sequence ${chunk.sequence}`);
  }
}

/** Bounded raw-WAV FIFO. Bytes leave this queue only after the backend ACKs durable storage. */
export class PersistenceQueue {
  private readonly items: QueueItem[] = [];
  private current: QueueItem | null = null;
  private processing = false;
  private blocked = false;
  private overflow = false;
  private protectedOverflow = 0;
  private completed = 0;
  private duplicates = 0;
  private lastError: string | null = null;
  private readonly drainWaiters: Array<(saved: boolean) => void> = [];

  constructor(private readonly options: PersistenceQueueOptions) {}

  retainedRawCount(): number {
    return this.items.length + (this.current ? 1 : 0);
  }

  getState(): PersistenceQueueState {
    return {
      pending: this.retainedRawCount(),
      inFlight: this.current?.chunk.sequence ?? null,
      completed: this.completed,
      duplicates: this.duplicates,
      failed: this.blocked && this.items[0]
        ? [{ sequence: this.items[0].chunk.sequence, error: this.lastError ?? 'Storage failed', attempts: this.items[0].attempts }]
        : [],
      droppedCount: 0,
      overflow: this.overflow,
      lastError: this.lastError,
    };
  }

  enqueue(chunk: AudioChunk): boolean {
    const maxPending = this.options.maxPending ?? DEFAULT_MAX_PENDING;
    const atLimit = this.retainedRawCount() >= maxPending;
    // Two protected slots hold (1) the window whose rejection tells the
    // recorder to stop and (2) the one partial tail emitted by stop's barrier.
    // This keeps raw retention bounded at maxPending + 2 without dropping the
    // capture tail.
    if (atLimit) {
      if (this.protectedOverflow >= 2) return false;
      const firstOverflow = !this.overflow;
      this.overflow = true;
      this.protectedOverflow += 1;
      this.items.push({ chunk, attempts: 0 });
      this.emit();
      if (firstOverflow) this.options.onBlocked?.();
      return false;
    }
    this.items.push({ chunk, attempts: 0 });
    this.emit();
    void this.run();
    return true;
  }

  retryFailed(): void {
    if (!this.blocked) return;
    this.blocked = false;
    if (this.items[0]) this.items[0].attempts = 0;
    this.emit();
    void this.run();
  }

  drain(): Promise<boolean> {
    if (this.blocked) return Promise.resolve(false);
    if (!this.processing && this.retainedRawCount() === 0) return Promise.resolve(true);
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private emit(): void {
    this.options.onChange?.(this.getState());
  }

  private settle(saved: boolean): void {
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve(saved);
  }

  private async run(): Promise<void> {
    if (this.processing || this.blocked) return;
    this.processing = true;
    while (this.items.length > 0 && !this.blocked) {
      const item = this.items.shift()!;
      this.current = item;
      this.emit();
      let stored = false;
      const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      while (!stored && item.attempts < maxAttempts) {
        item.attempts += 1;
        try {
          const ack = await this.options.store(item.chunk);
          validateAck(item.chunk, ack);
          this.lastError = null;
          this.completed += 1;
          if (ack.duplicate) this.duplicates += 1;
          this.options.onStored?.(item.chunk, ack);
          stored = true;
        } catch (error) {
          this.lastError = message(error);
          if (item.attempts < maxAttempts) {
            this.emit();
            await (this.options.sleep ?? sleep)((this.options.backoffMs ?? backoff)(item.attempts));
          }
        }
      }
      this.current = null;
      if (!stored) {
        this.items.unshift(item);
        this.blocked = true;
        this.emit();
        this.options.onBlocked?.();
        break;
      }
      this.emit();
    }
    this.processing = false;
    if (!this.blocked && this.items.length === 0) {
      this.overflow = false;
      this.protectedOverflow = 0;
    }
    this.emit();
    this.settle(!this.blocked && this.retainedRawCount() === 0);
  }
}
