// Turns the recorder's raw per-frame RMS/peak samples into an honest,
// non-amplified level meter: logarithmic dBFS and real peak-clipping detection.
// It measures loudness only; nothing here infers speech from amplitude.

export const FLOOR_DBFS = -60;
const CLIP_LINEAR_THRESHOLD = 0.98; // near PCM16 full scale
const CLIP_HOLD_MS = 1_500;
const WINDOW_MS = 300; // aggregation window — independent of worklet frame size
const EMIT_INTERVAL_MS = 100; // ~10Hz UI throttle; do not render per-frame

export interface MeterSnapshot {
  /** Logarithmic RMS level in dBFS across the measurement window. No gain applied. */
  dbfs: number;
  /** Logarithmic peak level in dBFS across the measurement window. */
  peakDbfs: number;
  /** True while a sample reached full scale, held briefly so it stays visible. */
  clipping: boolean;
}

interface FrameSample {
  startAudioMs: number;
  endAudioMs: number;
  sampleCount: number;
  meanSquare: number;
  peak: number;
}

const MAX_BUFFERED_FRAMES = 2_048;

/** Convert a linear 0..1 amplitude to dBFS, clamped at the silence floor. */
export function linearToDbfs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return FLOOR_DBFS;
  const db = 20 * Math.log10(value);
  return Number.isFinite(db) ? Math.max(FLOOR_DBFS, db) : FLOOR_DBFS;
}

export function idleMeterSnapshot(): MeterSnapshot {
  return { dbfs: FLOOR_DBFS, peakDbfs: FLOOR_DBFS, clipping: false };
}

/**
 * Aggregates raw per-frame rms/peak samples (delivered at worklet frame
 * cadence, e.g. every ~128 samples) into a time-windowed, throttled meter
 * snapshot. Nothing here amplifies the signal; it only measures and labels it.
 */
export class SignalMeter {
  private readonly now: () => number;
  private window: FrameSample[] = [];
  private audioMs = 0;
  private lastClipAtAudioMs: number | null = null;
  private lastEmitMs = -Infinity;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Feed one frame plus its sample timing. UI emission alone uses the wall-clock throttle. */
  push(rms: number, peak: number, sampleCount: number, sampleRate: number): MeterSnapshot | null {
    const at = this.now();
    const count = Number.isFinite(sampleCount) ? Math.max(0, Math.floor(sampleCount)) : 0;
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 0;
    if (count === 0 || rate === 0) return null;

    const safeRms = Number.isFinite(rms) ? Math.min(1, Math.max(0, rms)) : 0;
    const safePeak = Number.isFinite(peak) ? Math.min(1, Math.max(0, peak)) : 0;
    const startAudioMs = this.audioMs;
    this.audioMs += (count / rate) * 1_000;
    this.window.push({
      startAudioMs,
      endAudioMs: this.audioMs,
      sampleCount: count,
      meanSquare: safeRms * safeRms,
      peak: safePeak,
    });
    this.trimWindow();
    if (safePeak >= CLIP_LINEAR_THRESHOLD) this.lastClipAtAudioMs = this.audioMs;

    if (at - this.lastEmitMs < EMIT_INTERVAL_MS) return null;
    this.lastEmitMs = at;
    return this.compute();
  }

  /** Force a fresh snapshot regardless of the emit throttle (e.g. right after start). */
  peekSnapshot(): MeterSnapshot {
    this.trimWindow();
    return this.compute();
  }

  /** Public diagnostic seam used to assert the rolling window remains bounded. */
  bufferedFrameCount(): number {
    return this.window.length;
  }

  /**
   * Clears every diagnostic for a lifecycle transition so a prior session's
   * clipping state can never leak into pause, stop, or the next session.
   */
  reset(): MeterSnapshot {
    this.window = [];
    this.audioMs = 0;
    this.lastClipAtAudioMs = null;
    this.lastEmitMs = -Infinity;
    return this.compute();
  }

  private trimWindow(): void {
    const cutoff = this.audioMs - WINDOW_MS;
    while (this.window.length > 0 && this.window[0]!.endAudioMs <= cutoff) this.window.shift();
    while (this.window.length > MAX_BUFFERED_FRAMES) this.window.shift();
  }

  private aggregateRms(): number {
    if (this.window.length === 0) return 0;
    const cutoff = this.audioMs - WINDOW_MS;
    let weightedEnergy = 0;
    let weightedSamples = 0;
    for (const sample of this.window) {
      const durationMs = sample.endAudioMs - sample.startAudioMs;
      const overlapMs = sample.endAudioMs - Math.max(sample.startAudioMs, cutoff);
      const weight = durationMs > 0 ? sample.sampleCount * Math.min(1, overlapMs / durationMs) : 0;
      weightedEnergy += sample.meanSquare * weight;
      weightedSamples += weight;
    }
    return weightedSamples > 0 ? Math.sqrt(weightedEnergy / weightedSamples) : 0;
  }

  private aggregatePeak(): number {
    let max = 0;
    for (const s of this.window) if (s.peak > max) max = s.peak;
    return max;
  }

  private compute(): MeterSnapshot {
    const clipping = this.lastClipAtAudioMs !== null
      && this.audioMs - this.lastClipAtAudioMs <= CLIP_HOLD_MS;
    return {
      dbfs: linearToDbfs(this.aggregateRms()),
      peakDbfs: linearToDbfs(this.aggregatePeak()),
      clipping,
    };
  }
}
