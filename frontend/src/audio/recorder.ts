import { WindowChunker } from './chunker';
import { SampleTimeline } from './clock';
import { encodeWavPcm16Mono } from './wav';

// Microphone capture via AudioWorklet. Produces standalone 5-second PCM16 mono
// WAV windows with sequence numbers and recording-timeline timestamps (pauses
// excluded). On pause/stop the tail is flushed so the last words are never
// dropped. Sample rate is the device rate; the backend resamples for local ASR
// as needed (docs/API.md).

const WINDOW_SECONDS = 5;


// Served from public/ so it loads under CSP script-src 'self'. BASE_URL ends
// in '/', and is '/' in dev and './' in the packaged file:// build.
const WORKLET_URL = `${import.meta.env.BASE_URL}pcm-worklet.js`;

export interface RecordedChunk {
  sequence: number;
  startMs: number;
  endMs: number;
  wav: ArrayBuffer;
  sampleRate: number;
}

export interface RecordedSignal {
  /** Unamplified RMS for this frame, linear 0..1. */
  rms: number;
  /** Peak absolute sample for this frame, linear 0..1 — needed for real clip detection. */
  peak: number;
  /** Number of PCM samples represented by this measurement frame. */
  sampleCount: number;
  /** Device sample rate used to derive recording-time duration. */
  sampleRate: number;
}

export interface RecorderCallbacks {
  /** Establish durable transport at the device sample rate before capture connects. */
  onReady?: (sampleRate: number) => Promise<void>;
  onChunk: (chunk: RecordedChunk) => boolean | void;
  onLevel?: (level: number) => void;
  /** Raw per-frame rms/peak for a level meter to aggregate; unthrottled, no gain applied. */
  onSignal?: (sample: RecordedSignal) => void;
  onError?: (message: string) => void;
  onDisconnected?: () => void;
  /** Sticky loss of confidence: received PCM is saved, but an in-flight tail may be missing. */
  onCaptureIncomplete?: () => void;
}

export type RecorderState = 'idle' | 'recording' | 'paused' | 'processing' | 'stopped';

interface BarrierMessage {
  type: 'barrier';
  id: number;
}

const BARRIER_TIMEOUT_MS = 2_000;

export class AudioRecorder {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;

  private timeline: SampleTimeline | null = null;
  private chunker: WindowChunker | null = null;
  private sampleRate = 48000;
  private sequence = 0;

  private _state: RecorderState = 'idle';
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private barrierId = 0;
  private readonly barrierWaiters = new Map<number, () => void>();

  constructor(
    private readonly callbacks: RecorderCallbacks,
    private readonly options: { windowSeconds?: number } = {},
  ) {
    const seconds = options.windowSeconds ?? WINDOW_SECONDS;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > WINDOW_SECONDS) {
      throw new Error('Invalid recording window duration.');
    }
  }

  get state(): RecorderState {
    return this._state;
  }

  elapsedMs(): number {
    return this.timeline?.elapsedMs() ?? 0;
  }

  async start(deviceId?: string): Promise<void> {
    if (['recording', 'processing', 'paused'].includes(this._state)) return;
    this._state = 'processing';
    this.stopRequested = false;
    this.stopPromise = null;
    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this.stopRequested) throw new Error('Recording start was cancelled.');
      this.context = new AudioContext();
      this.sampleRate = this.context.sampleRate;
      this.timeline = new SampleTimeline(this.sampleRate);
      this.chunker = new WindowChunker(Math.max(1, Math.round((this.options.windowSeconds ?? WINDOW_SECONDS) * this.sampleRate)));

      await this.context.audioWorklet.addModule(WORKLET_URL);
      if (this.stopRequested) throw new Error('Recording start was cancelled.');
      await this.callbacks.onReady?.(this.sampleRate);
      if (this.stopRequested) throw new Error('Recording start was cancelled.');
      this.source = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, 'pcm-forwarder');
      this.worklet.port.onmessage = (event: MessageEvent<Float32Array | BarrierMessage>) => {
        const data = event.data;
        if (data instanceof Float32Array) this.onFrame(data);
        else if (data?.type === 'barrier') {
          this.barrierWaiters.get(data.id)?.();
          this.barrierWaiters.delete(data.id);
        }
      };
      this.source.connect(this.worklet);

      this.sequence = 0;
      this.stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (this._state === 'stopped' || this._state === 'idle') return;
          this.callbacks.onError?.('Microphone disconnected; captured audio is being flushed');
          void this.stop().finally(() => this.callbacks.onDisconnected?.());
        });
      });
      this._state = 'recording';
    } catch (err) {
      await this.teardown();
      this._state = this.stopRequested ? 'stopped' : 'idle';
      throw err;
    }
  }

  private onFrame(frame: Float32Array): void {
    if ((this._state !== 'recording' && !this.draining) || !this.chunker) return;
    this.timeline?.accept(frame.length);

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i += 1) {
      const v = frame[i]!;
      sum += v * v;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }
    const rms = Math.min(1, Math.sqrt(sum / Math.max(1, frame.length)));
    const clampedPeak = Math.min(1, peak);
    this.callbacks.onLevel?.(rms);
    this.callbacks.onSignal?.({
      rms,
      peak: clampedPeak,
      sampleCount: frame.length,
      sampleRate: this.sampleRate,
    });

    for (const window of this.chunker.push(frame)) {
      const accepted = this.emitWindow(window);
      if (!accepted) break;
    }
  }

  private emitWindow(samples: Float32Array): boolean {
    if (!this.timeline) return false;
    const { startMs, endMs } = this.timeline.rangeFor(samples.length);
    const wav = encodeWavPcm16Mono(samples, this.sampleRate);
    const accepted = this.callbacks.onChunk({
      sequence: this.sequence,
      startMs,
      endMs,
      wav,
      sampleRate: this.sampleRate,
    });
    this.sequence += 1;
    return accepted !== false;
  }

  async pause(): Promise<void> {
    if (this._state !== 'recording') return;
    this._state = 'processing';
    await this.drainCapture();
    if (!this.stopRequested) this._state = 'paused';
  }

  async resume(): Promise<void> {
    if (this._state !== 'paused') return;
    if (this.source && this.worklet) this.source.connect(this.worklet);
    this._state = 'recording';
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this._state === 'idle' || this._state === 'stopped') return;
    this.stopRequested = true;
    this._state = 'processing';
    // Stop the physical input immediately; still accept queued PCM up to the barrier.
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<void> {
    try {
      await this.drainCapture();
    } finally {
      await this.teardown();
      this._state = 'stopped';
    }
  }

  private drainCapture(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.draining = true;
    this.source?.disconnect();
    this.drainPromise = this.awaitWorkletBarrier().then(async (complete) => {
      this.draining = false;
      this.flushTail();
      if (!complete) {
        this.stopRequested = true;
        this.callbacks.onCaptureIncomplete?.();
        this.callbacks.onError?.('Audio flush failed; capture completeness is unknown. Received audio is being saved.');
        await this.teardown();
        this._state = 'stopped';
      }
    }).finally(() => {
      this.draining = false;
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  /** Emit whatever partial window remains as a final short chunk. */
  private flushTail(): void {
    if (!this.chunker) return;
    const tail = this.chunker.flush();
    if (tail && tail.length > 0) this.emitWindow(tail);
  }

  private awaitWorkletBarrier(): Promise<boolean> {
    if (!this.worklet) return Promise.resolve(true);
    const id = ++this.barrierId;
    return new Promise((resolve) => {
      const finish = (complete: boolean) => {
        window.clearTimeout(timer);
        this.barrierWaiters.delete(id);
        resolve(complete);
      };
      const timer = window.setTimeout(() => finish(false), BARRIER_TIMEOUT_MS);
      this.barrierWaiters.set(id, () => finish(true));
      try {
        this.worklet!.port.postMessage({ type: 'barrier', id });
      } catch {
        finish(false);
      }
    });
  }

  private async teardown(): Promise<void> {
    try {
      this.worklet?.port.close();
      this.worklet?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      if (this.context && this.context.state !== 'closed') await this.context.close();
    } finally {
      this.worklet = null;
      this.source = null;
      this.stream = null;
      this.context = null;
      this.chunker = null;
      this.barrierWaiters.clear();
    }
  }
}
