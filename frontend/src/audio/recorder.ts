import { WindowChunker } from './chunker';
import { SampleTimeline } from './clock';
import { encodeWavPcm16Mono } from './wav';

// Microphone capture via AudioWorklet. Produces standalone 5-second PCM16 mono
// WAV windows with sequence numbers and recording-timeline timestamps (pauses
// excluded). On pause/stop the tail is flushed so the last words are never
// dropped. Sample rate is the device rate; the backend resamples for local ASR
// as needed (docs/API.md).

const WINDOW_SECONDS = 5;
const LEVEL_SMOOTHING = 0.2;

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

export interface RecorderCallbacks {
  onChunk: (chunk: RecordedChunk) => boolean | void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
  onDisconnected?: () => void;
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
  private level = 0;
  private _state: RecorderState = 'idle';
  private barrierId = 0;
  private readonly barrierWaiters = new Map<number, () => void>();

  constructor(private readonly callbacks: RecorderCallbacks) {}

  get state(): RecorderState {
    return this._state;
  }

  elapsedMs(): number {
    return this.timeline?.elapsedMs() ?? 0;
  }

  async start(deviceId?: string): Promise<void> {
    if (this._state === 'recording') return;
    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false }
        : { echoCancellation: false, noiseSuppression: false },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.context = new AudioContext();
      this.sampleRate = this.context.sampleRate;
      this.timeline = new SampleTimeline(this.sampleRate);
      this.chunker = new WindowChunker(Math.round(WINDOW_SECONDS * this.sampleRate));

      await this.context.audioWorklet.addModule(WORKLET_URL);
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
      this._state = 'idle';
      throw err;
    }
  }

  private onFrame(frame: Float32Array): void {
    if (this._state !== 'recording' || !this.chunker) return;
    this.timeline?.accept(frame.length);

    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    this.level = this.level + LEVEL_SMOOTHING * (rms - this.level);
    this.callbacks.onLevel?.(Math.min(1, this.level * 4));

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
    this.source?.disconnect();
    await this.awaitWorkletBarrier();
    this.flushTail();
    this._state = 'paused';
  }

  async resume(): Promise<void> {
    if (this._state !== 'paused') return;
    if (this.source && this.worklet) this.source.connect(this.worklet);
    this._state = 'recording';
  }

  async stop(): Promise<void> {
    if (this._state === 'idle' || this._state === 'stopped') return;
    this._state = 'processing';
    this.source?.disconnect();
    await this.awaitWorkletBarrier();
    this.flushTail();
    await this.teardown();
    this._state = 'stopped';
  }

  /** Emit whatever partial window remains as a final short chunk. */
  private flushTail(): void {
    if (!this.chunker) return;
    const tail = this.chunker.flush();
    if (tail && tail.length > 0) this.emitWindow(tail);
  }

  private awaitWorkletBarrier(): Promise<void> {
    if (!this.worklet) return Promise.resolve();
    const id = ++this.barrierId;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.barrierWaiters.delete(id);
        this.callbacks.onError?.('Audio flush barrier timed out; stopping capture safely');
        resolve();
      }, BARRIER_TIMEOUT_MS);
      this.barrierWaiters.set(id, () => {
        window.clearTimeout(timer);
        resolve();
      });
      this.worklet!.port.postMessage({ type: 'barrier', id });
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
