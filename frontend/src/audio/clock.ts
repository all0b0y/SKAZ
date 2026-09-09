// Monotonic recording timeline that excludes paused wall time, so every chunk
// and segment timestamp is measured in "recording milliseconds" independent of
// the system clock (docs/ARCHITECTURE.md: "Время записи отделено от системных
// часов", pauses excluded for v0 per docs/API.md).

export type RecordingClockState = 'idle' | 'recording' | 'paused' | 'stopped';

/**
 * Audio timeline derived only from captured samples. Message scheduling and
 * wall-clock stalls cannot introduce gaps or overlaps.
 */
export class SampleTimeline {
  private acceptedSamples = 0;
  private emittedSamples = 0;

  constructor(private readonly sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('sampleRate must be positive');
    }
  }

  accept(sampleCount: number): void {
    if (!Number.isInteger(sampleCount) || sampleCount < 0) {
      throw new Error('sampleCount must be a non-negative integer');
    }
    this.acceptedSamples += sampleCount;
  }

  elapsedMs(): number {
    return Math.round((this.acceptedSamples / this.sampleRate) * 1000);
  }

  rangeFor(sampleCount: number): { startMs: number; endMs: number } {
    if (!Number.isInteger(sampleCount) || sampleCount < 0) {
      throw new Error('sampleCount must be a non-negative integer');
    }
    const startSamples = this.emittedSamples;
    this.emittedSamples += sampleCount;
    if (this.emittedSamples > this.acceptedSamples) {
      this.emittedSamples = startSamples;
      throw new Error('cannot emit more samples than were accepted');
    }
    return {
      startMs: Math.round((startSamples / this.sampleRate) * 1000),
      endMs: Math.round((this.emittedSamples / this.sampleRate) * 1000),
    };
  }
}

export class RecordingClock {
  private readonly now: () => number;
  private accumulatedMs = 0;
  private segmentStart: number | null = null;
  private _state: RecordingClockState = 'idle';

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  get state(): RecordingClockState {
    return this._state;
  }

  start(): void {
    if (this._state !== 'idle') return;
    this.accumulatedMs = 0;
    this.segmentStart = this.now();
    this._state = 'recording';
  }

  pause(): void {
    if (this._state !== 'recording') return;
    this.accumulatedMs += this.now() - (this.segmentStart ?? this.now());
    this.segmentStart = null;
    this._state = 'paused';
  }

  resume(): void {
    if (this._state !== 'paused') return;
    this.segmentStart = this.now();
    this._state = 'recording';
  }

  stop(): void {
    if (this._state === 'recording') {
      this.accumulatedMs += this.now() - (this.segmentStart ?? this.now());
    }
    this.segmentStart = null;
    this._state = 'stopped';
  }

  /** Recording time in whole milliseconds, excluding paused spans. */
  elapsedMs(): number {
    if (this._state === 'recording' && this.segmentStart !== null) {
      return Math.floor(this.accumulatedMs + (this.now() - this.segmentStart));
    }
    return Math.floor(this.accumulatedMs);
  }
}
