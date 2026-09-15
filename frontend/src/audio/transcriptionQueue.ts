import type { AudioIngestResponse, Segment } from '../api/types';

export interface AudioDescriptor {
  sessionId: string;
  sequence: number;
  startMs: number;
  endMs: number;
}

export interface FailedTranscription extends AudioDescriptor {
  error: string;
}

export interface TranscriptionQueueState {
  pending: number;
  inFlight: number | null;
  completed: number;
  failed: FailedTranscription[];
  deferred: number;
  diskFailed: number;
  blockedByConsent: boolean;
  lastError: string | null;
}

export interface TranscriptionQueueOptions {
  materialize: (descriptor: AudioDescriptor) => Promise<ArrayBuffer>;
  transcribe: (descriptor: AudioDescriptor, wav: ArrayBuffer) => Promise<AudioIngestResponse>;
  canTranscribe?: () => boolean;
  maxPending?: number;
  onSegments?: (descriptor: AudioDescriptor, segments: Segment[]) => void;
  onChange?: (state: TranscriptionQueueState) => void;
  onCapacity?: () => void;
}

const DEFAULT_MAX_PENDING = 32;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Descriptor-only ASR scheduler. It materializes exactly one persisted WAV at a time. */
export class TranscriptionQueue {
  private readonly items: AudioDescriptor[] = [];
  private readonly failedItems: FailedTranscription[] = [];
  private readonly known = new Set<string>();
  private current: AudioDescriptor | null = null;
  private processing = false;
  private completed = 0;
  private deferred = 0;
  private diskFailed = 0;
  private blockedByConsent = false;
  private lastError: string | null = null;
  private readonly drainWaiters: Array<() => void> = [];

  constructor(private readonly options: TranscriptionQueueOptions) {}

  retainedRawCount(): number { return 0; }

  private key(descriptor: AudioDescriptor): string {
    return `${descriptor.sessionId}:${descriptor.sequence}`;
  }

  hasSequence(descriptor: AudioDescriptor): boolean { return this.known.has(this.key(descriptor)); }

  private maxPending(): number { return this.options.maxPending ?? DEFAULT_MAX_PENDING; }

  getState(): TranscriptionQueueState {
    return {
      pending: this.items.length + (this.current ? 1 : 0),
      inFlight: this.current?.sequence ?? null,
      completed: this.completed,
      failed: this.failedItems.map((item) => ({ ...item })),
      deferred: this.deferred,
      diskFailed: this.diskFailed,
      blockedByConsent: this.blockedByConsent,
      lastError: this.lastError,
    };
  }

  setManifestCounts(deferred: number, diskFailed: number): void {
    this.deferred = Math.max(0, deferred);
    this.diskFailed = Math.max(0, diskFailed);
    this.emit();
  }

  enqueue(descriptor: AudioDescriptor): boolean {
    const key = this.key(descriptor);
    if (this.known.has(key)) return true;
    // Failed descriptors remain known until an explicit retry. Counting the
    // complete known set prevents later persistence ACKs from growing either
    // failedItems or known after the failure cap is reached.
    if (this.known.size >= this.maxPending()) {
      this.deferred += 1;
      this.emit();
      return false;
    }
    this.known.add(key);
    this.items.push(descriptor);
    this.emit();
    void this.run();
    return true;
  }

  retryFailed(): void {
    const retrying = this.failedItems.splice(0);
    for (const item of retrying) {
      const { error: _error, ...descriptor } = item;
      this.items.push(descriptor);
    }
    this.blockedByConsent = false;
    this.emit();
    void this.run();
  }

  resume(): void {
    this.blockedByConsent = false;
    void this.run();
  }

  drain(): Promise<void> {
    if (!this.processing && (this.items.length === 0 || this.blockedByConsent)) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private emit(): void { this.options.onChange?.(this.getState()); }

  private settle(): void {
    if (this.processing || (this.items.length > 0 && !this.blockedByConsent)) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  private async run(): Promise<void> {
    if (this.processing) return;
    if (this.options.canTranscribe && !this.options.canTranscribe()) {
      this.blockedByConsent = this.items.length > 0;
      this.emit();
      this.settle();
      return;
    }
    this.blockedByConsent = false;
    this.processing = true;
    while (this.items.length > 0) {
      const descriptor = this.items.shift()!;
      this.current = descriptor;
      this.emit();
      try {
        const wav = await this.options.materialize(descriptor);
        // Consent can change while persisted bytes are being read. Never cross
        // the outbound boundary on a stale pre-materialization decision.
        if (this.options.canTranscribe && !this.options.canTranscribe()) {
          this.items.unshift(descriptor);
          this.blockedByConsent = true;
          break;
        }
        const response = await this.options.transcribe(descriptor, wav);
        this.completed += 1;
        this.known.delete(this.key(descriptor));
        this.options.onSegments?.(descriptor, response.segments);
        this.options.onCapacity?.();
      } catch (error) {
        const detail = errorMessage(error);
        this.lastError = detail;
        this.failedItems.push({ ...descriptor, error: detail });
      } finally {
        this.current = null;
        this.emit();
      }
      if (this.failedItems.length >= this.maxPending()) {
        // Stop filling renderer memory after a bounded run of failures. The
        // unscheduled descriptors remain discoverable from the disk manifest.
        for (const pending of this.items) this.known.delete(this.key(pending));
        this.deferred += this.items.length;
        this.items.length = 0;
        this.emit();
        break;
      }
      if (this.options.canTranscribe && !this.options.canTranscribe()) {
        this.blockedByConsent = this.items.length > 0;
        break;
      }
    }
    this.processing = false;
    this.emit();
    this.settle();
  }
}
