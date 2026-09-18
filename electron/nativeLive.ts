import WebSocket, { type RawData } from 'ws';
import type { BackendHandle } from './backend';
import type { NativeAudioMeta, NativeFailure, NativeOpened, NativeSaved, NativeStopped } from '../frontend/src/api/nativeLive';

const IO_TIMEOUT_MS = 5_000;
const END_TIMEOUT_MS = 15_000;
const failure = () => new Error('Native audio transport failed; saved coverage must be checked before retry.');
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const sessionIdValid = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

type WireMessage = Record<string, unknown>;
interface Waiter {
  type: string;
  resolve: (message: WireMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One local connection. Queued operations are bounded before retaining PCM. */
class NativeConnection {
  phase: 'opening' | 'open' | 'ending' | 'closed' | 'failed' = 'opening';
  private readonly socket: WebSocket;
  private waiter: Waiter | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private queuedBytes = 0;
  private queuedCount = 0;
  private ending: Promise<NativeStopped> | null = null;

  constructor(
    readonly sessionId: string,
    readonly rate: number,
    handle: BackendHandle,
    private readonly onFailure: (event: NativeFailure) => void,
  ) {
    this.socket = new WebSocket(`ws://127.0.0.1:${handle.port}/sessions/${sessionId}/live/stream`, {
      headers: { Authorization: `Bearer ${handle.token}` },
      handshakeTimeout: IO_TIMEOUT_MS,
      maxPayload: 16_384,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.socket.on('message', (raw, binary) => this.message(raw, binary));
    this.socket.on('error', () => this.fail());
    this.socket.on('close', () => {
      if (this.phase !== 'closed') this.fail();
    });
  }

  private fail(code: NativeFailure['code'] = 'native_stream_failed'): void {
    if (this.phase === 'failed' || this.phase === 'closed') return;
    this.phase = 'failed';
    const pending = this.waiter;
    this.waiter = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure());
    }
    this.socket.terminate();
    this.onFailure({ sessionId: this.sessionId, code });
  }

  private message(raw: RawData, binary: boolean): void {
    try {
      if (binary) throw failure();
      const message: unknown = JSON.parse(raw.toString());
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw failure();
      const value = message as WireMessage;
      if (value.type === 'stream.error' && (value.code === 'invalid_stream' || value.code === 'storage_failed')) {
        this.fail(value.code);
        return;
      }
      const pending = this.waiter;
      if (!pending || value.type !== pending.type) throw failure();
      clearTimeout(pending.timer);
      this.waiter = null;
      pending.resolve(value);
    } catch {
      this.fail();
    }
  }

  private response(type: string, timeout = IO_TIMEOUT_MS): Promise<WireMessage> {
    if (this.waiter || this.phase === 'failed') return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      this.waiter = { type, resolve, reject, timer: setTimeout(() => this.fail(), timeout) };
    });
  }

  private send(data: string | Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) { this.fail(); return; }
    try {
      this.socket.send(data, (error) => { if (error) this.fail(); });
    } catch {
      this.fail();
    }
  }

  async open(): Promise<NativeOpened> {
    const opened = this.response('stream.opened');
    this.socket.once('open', () => this.send(JSON.stringify({ type: 'open', sample_rate: this.rate })));
    const message = await opened;
    if (this.phase === 'failed') throw failure();
    if (typeof message.connection_id !== 'string' || message.sample_rate !== this.rate
      || !integer(message.saved_samples) || !integer(message.next_sequence)
      || (message.audio_retained !== undefined && typeof message.audio_retained !== 'boolean')
      || !['connecting', 'unavailable', 'disabled'].includes(String(message.transcription))) {
      this.fail(); throw failure();
    }
    this.phase = 'open';
    return {
      connection_id: message.connection_id, sample_rate: this.rate,
      saved_samples: message.saved_samples, next_sequence: message.next_sequence,
      transcription: message.transcription as NativeOpened['transcription'],
      ...(message.audio_retained === false ? { audio_retained: false } : {}),
    };
  }

  audio(meta: NativeAudioMeta, pcm: ArrayBuffer): Promise<NativeSaved> {
    if (this.phase !== 'open' || !meta || !integer(meta.sequence) || !integer(meta.startSample)
      || !(pcm instanceof ArrayBuffer) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0
      || pcm.byteLength > this.rate || !integer(meta.startSample + pcm.byteLength / 2)) {
      return Promise.reject(new Error('Invalid native PCM packet or stream state.'));
    }
    if (this.queuedCount >= 64 || this.queuedBytes + pcm.byteLength > this.rate * 4) {
      return Promise.reject(new Error('Native audio queue is full; stop capture and preserve unsaved PCM.'));
    }
    const length = pcm.byteLength;
    // Copy now: the caller cannot mutate queued bytes or metadata after validation.
    const frame = Buffer.allocUnsafe(20 + length);
    frame.writeBigUInt64BE(BigInt(meta.sequence), 0);
    frame.writeBigUInt64BE(BigInt(meta.startSample), 8);
    frame.writeUInt32BE(length / 2, 16);
    Buffer.from(pcm).copy(frame, 20);
    const sequence = meta.sequence;
    const endSample = meta.startSample + length / 2;
    this.queuedBytes += length;
    this.queuedCount += 1;
    const pending = this.chain.then(async () => {
      const result = this.response('audio.saved');
      this.send(frame);
      const message = await result;
      if (message.sequence !== sequence || !integer(message.saved_samples) || message.saved_samples < endSample
        || typeof message.duplicate !== 'boolean') { this.fail(); throw failure(); }
      return { sequence, saved_samples: message.saved_samples, duplicate: message.duplicate };
    }).finally(() => { this.queuedBytes -= length; this.queuedCount -= 1; });
    this.chain = pending.catch(() => undefined);
    return pending;
  }

  end(action: 'pause' | 'stop'): Promise<NativeStopped> {
    if (!['pause', 'stop'].includes(action)) return Promise.reject(failure());
    if (this.ending) return this.ending;
    if (this.phase !== 'open') return Promise.reject(failure());
    this.phase = 'ending';
    this.ending = this.chain.then(async () => {
      const result = this.response('stream.stopped', END_TIMEOUT_MS);
      this.send(JSON.stringify({ type: 'end', action }));
      const message = await result;
      const status = action === 'pause' ? 'paused' : 'stopped';
      if (!integer(message.saved_samples) || typeof message.transcription_complete !== 'boolean'
        || message.status !== status) { this.fail(); throw failure(); }
      this.phase = 'closed';
      this.socket.close();
      return { saved_samples: message.saved_samples, transcription_complete: message.transcription_complete, status };
    });
    return this.ending;
  }

  abort(): void { this.fail(); }
}

/** Main owns auth, target URL and the single capture owner; renderer supplies neither. */
export class NativeLiveClient {
  private connection: NativeConnection | null = null;

  constructor(
    private readonly getHandle: () => BackendHandle | null,
    private readonly onFailure: (event: NativeFailure) => void = () => undefined,
  ) {}

  async open(sessionId: string, sampleRate: number): Promise<NativeOpened> {
    if (!sessionIdValid(sessionId) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
      throw new Error('Invalid native stream configuration.');
    }
    if (this.connection && !['closed', 'failed'].includes(this.connection.phase)) throw new Error('Capture already active.');
    const handle = this.getHandle();
    if (!handle) throw new Error('Backend not ready.');
    const connection = new NativeConnection(sessionId, sampleRate, handle, this.onFailure);
    this.connection = connection;
    return connection.open();
  }

  async audio(sessionId: string, meta: NativeAudioMeta, pcm: ArrayBuffer): Promise<NativeSaved> {
    if (!this.connection || this.connection.sessionId !== sessionId) throw new Error('Wrong native capture owner.');
    return this.connection.audio(meta, pcm);
  }

  async end(sessionId: string, action: 'pause' | 'stop'): Promise<NativeStopped> {
    if (!this.connection || this.connection.sessionId !== sessionId) throw new Error('Wrong native capture owner.');
    return this.connection.end(action);
  }

  abort(): void { this.connection?.abort(); }
}
