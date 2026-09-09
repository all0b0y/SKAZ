// Accumulates streamed Float32 audio frames into fixed-length windows without
// ever losing or reordering a sample. The recorder feeds worklet frames in;
// completed windows come out to be WAV-encoded and uploaded, and flush() emits
// the sub-window tail on pause/stop so the last words are never dropped
// (docs/ARCHITECTURE.md: "Остановка дожидается обработки хвоста").

export class WindowChunker {
  private readonly windowSamples: number;
  private buffer: Float32Array;
  private length = 0;

  constructor(windowSamples: number) {
    if (windowSamples <= 0) throw new Error('windowSamples must be positive');
    this.windowSamples = windowSamples;
    this.buffer = new Float32Array(windowSamples);
  }

  get buffered(): number {
    return this.length;
  }

  private ensureCapacity(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  /** Append a frame; return every complete window it made available. */
  push(frame: Float32Array): Float32Array[] {
    this.ensureCapacity(frame.length);
    this.buffer.set(frame, this.length);
    this.length += frame.length;

    const windows: Float32Array[] = [];
    let consumed = 0;
    while (this.length - consumed >= this.windowSamples) {
      windows.push(this.buffer.slice(consumed, consumed + this.windowSamples));
      consumed += this.windowSamples;
    }
    if (consumed > 0) {
      this.buffer.copyWithin(0, consumed, this.length);
      this.length -= consumed;
    }
    return windows;
  }

  /** Emit whatever remains (shorter than a full window) and reset. */
  flush(): Float32Array | null {
    if (this.length === 0) return null;
    const tail = this.buffer.slice(0, this.length);
    this.length = 0;
    return tail;
  }
}
