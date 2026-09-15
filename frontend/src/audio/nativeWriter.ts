import type { ApiClient } from '../api/client';
import type { NativeOpened } from '../api/nativeLive';
import type { AudioChunk } from './uploadQueue';
import type { PersistedAudioAck } from './persistenceQueue';

/** Renderer-side sample clock. Raw bytes remain in PersistenceQueue until a durable ACK. */
export class NativeAudioWriter {
  private rate: number | null = null;
  private sequence = 0;
  private samples = 0;
  private connected = false;
  private failed = false;
  private paused = false;
  private stopped = false;
  private attempted: AudioChunk | null = null;
  private recovered: number | null = null;
  private opening: Promise<void> | null = null;
  private finishing: Promise<void> | null = null;

  constructor(
    private readonly api: ApiClient,
    readonly sessionId: string,
    private readonly onOpened?: (opened: NativeOpened) => void,
  ) {}

  disconnect(): void { this.connected = false; this.failed = true; }

  open(rate = this.rate): Promise<void> {
    if (this.opening) return this.opening;
    if (this.connected) return Promise.resolve();
    if (rate === null || (this.rate !== null && rate !== this.rate) || this.stopped) {
      return Promise.reject(new Error('Native recording sample rate is unavailable or changed.'));
    }
    this.rate = rate;
    this.opening = this.api.openNative(this.sessionId, rate).then((opened) => {
      // Only the last attempted block may have committed without its ACK arriving.
      const lostAck = this.attempted && opened.next_sequence === this.sequence + 1
        && opened.saved_samples === this.samples + (this.attempted.wav.byteLength - 44) / 2;
      if (opened.sample_rate !== rate || (!lostAck
        && (opened.next_sequence !== this.sequence || opened.saved_samples !== this.samples))) {
        this.failed = true;
        throw new Error('Native recording clock differs from retained audio; no bytes were discarded.');
      }
      this.recovered = lostAck ? this.sequence : null;
      this.connected = true;
      this.failed = false;
      this.paused = false;
      this.onOpened?.(opened);
    }).catch((error: unknown) => { this.disconnect(); throw error; })
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  async store(chunk: AudioChunk): Promise<PersistedAudioAck> {
    if (!this.connected || this.failed || this.finishing || chunk.sequence !== this.sequence) {
      throw new Error('Native audio stream is not ready; retained audio requires explicit retry.');
    }
    const header = new DataView(chunk.wav);
    if (chunk.wav.byteLength <= 44 || (chunk.wav.byteLength - 44) % 2 !== 0
      || header.getUint16(20, true) !== 1 || header.getUint16(22, true) !== 1
      || header.getUint32(24, true) !== this.rate || header.getUint16(34, true) !== 16
      || header.getUint32(40, true) !== chunk.wav.byteLength - 44) {
      throw new Error('Invalid captured PCM WAV.');
    }
    const count = (chunk.wav.byteLength - 44) / 2;
    let duplicate = this.recovered === chunk.sequence;
    if (duplicate && this.attempted) {
      const previous = new Uint8Array(this.attempted.wav);
      if (previous.length !== chunk.wav.byteLength || !new Uint8Array(chunk.wav).every((value, index) => value === previous[index])) {
        throw new Error('Retained audio changed after a lost ACK.');
      }
    }
    this.attempted = chunk;
    try {
      if (!duplicate) {
        const ack = await this.api.sendNativeAudio(this.sessionId, {
          sequence: chunk.sequence, startSample: this.samples,
        }, chunk.wav.slice(44));
        if (ack.sequence !== this.sequence || ack.saved_samples !== this.samples + count) {
          throw new Error('Native saved clock does not match submitted audio.');
        }
        duplicate = ack.duplicate;
      }
      this.samples += count;
      this.sequence += 1;
      this.attempted = null;
      this.recovered = null;
      return { sequence: chunk.sequence, start_ms: chunk.startMs, end_ms: chunk.endMs,
        status: 'pending', available: true, duplicate, source_kind: 'original_captured_wav' };
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  async finish(action: 'pause' | 'stop'): Promise<void> {
    if (this.opening) await this.opening;
    if (this.finishing) {
      await this.finishing;
      if (action === 'stop' && !this.stopped) await this.finish('stop');
      return;
    }
    if (this.stopped || (this.paused && action === 'pause')) return;
    if (this.failed) throw new Error('Native finalization needs an explicit reconnect/retry.');
    if (!this.connected && !this.paused) return; // capture never acquired a transport
    this.finishing = (async () => {
      if (this.connected) {
        const ack = await this.api.endNative(this.sessionId, action);
        if (ack.saved_samples !== this.samples || ack.status !== (action === 'pause' ? 'paused' : 'stopped')) {
          throw new Error('Native finalization ACK does not match recording state.');
        }
      } else {
        await this.api.setSessionStatus(this.sessionId, 'stopped', { flush_transcription: false });
      }
      this.connected = false;
      this.paused = action === 'pause';
      this.stopped = action === 'stop';
    })().catch((error: unknown) => { this.disconnect(); throw error; })
      .finally(() => { this.finishing = null; });
    await this.finishing;
  }
}
