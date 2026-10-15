// The sound path of a recording in the new interface is the EXISTING pipeline of the old UI —
// AudioRecorder (mic + optional system audio, AudioWorklet), PersistenceQueue, NativeAudioWriter
// over `bridge.openNative/sendNativeAudio/endNative`, SignalMeter — wired to the session that
// `POST /kb/recordings` returns. Nothing here re-implements capture; it only composes the modules
// the way `state/store.ts#startRecording/pauseRecording/stopRecording` does.

import type { BridgeApi } from '../../api/bridge';
import { ApiClient } from '../../api/client';
import type { NativeFailure } from '../../api/nativeLive';
import { SignalMeter, type MeterSnapshot } from '../../audio/meter';
import { NativeAudioWriter } from '../../audio/nativeWriter';
import { PersistenceQueue } from '../../audio/persistenceQueue';
import { AudioRecorder, SystemAudioUnavailable, type CaptureSources } from '../../audio/recorder';

export interface CaptureCallbacks {
  /** Real meter snapshot (~10 Hz while sound arrives; nothing during silence-free gaps). */
  onLevel: (snapshot: MeterSnapshot) => void;
  /** Capture or recognition stopped on its own; the text saved so far stays. */
  onFailure: (message: string) => void;
}

export interface CaptureStart {
  sessionId: string;
  sources: CaptureSources;
  /** Continuing an existing session: its PCM clock (from `/sessions/{id}/live`). */
  sampleRate?: number;
}

/** One recording attempt's capture. Implemented by the native pipeline; faked in tests. */
export interface CaptureEngine {
  start(start: CaptureStart, callbacks: CaptureCallbacks): Promise<void>;
  pause(): Promise<void>;
  resume(sources: CaptureSources): Promise<void>;
  /** Stops capture and waits for local saving; false = audio is still unsaved (keep the quit guard). */
  stop(): Promise<boolean>;
  /** The last flush of the capture graph never confirmed: its final moment may be missing. */
  incomplete?(): boolean;
  /** Recording time of this attempt plus what the session already had. */
  elapsedMs(): number;
  /** Unsent audio, for the quit guard in main. */
  pending(): { pending: number; failed: number };
}

export type CaptureFactory = () => CaptureEngine;

type NativeBridge = Pick<BridgeApi, 'request' | 'openNative' | 'sendNativeAudio' | 'endNative' | 'onNativeFailure'>;

export function captureErrorText(error: unknown): string {
  if (error instanceof SystemAudioUnavailable) {
    return error.reason === 'denied'
      ? 'Computer sound wasn’t allowed. Allow screen & system audio recording for SKAZ in System Settings, or record the microphone only.'
      : 'Computer sound isn’t available on this Mac. Record the microphone only.';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/denied|not allowed|permission/i.test(message)) {
    return 'Microphone access was denied. Allow it for SKAZ in System Settings and try again.';
  }
  return message || 'Recording couldn’t start.';
}

/** The native pipeline, composed exactly as the old recorder store does it. */
export function nativeCapture(bridge: NativeBridge): CaptureEngine {
  const api = new ApiClient(bridge as BridgeApi);
  let recorder: AudioRecorder | null = null;
  let writer: NativeAudioWriter | null = null;
  let queue: PersistenceQueue | null = null;
  let offsetMs = 0;
  let unlisten: (() => void) | null = null;
  let incomplete = false;

  return {
    async start({ sessionId, sources, sampleRate }, callbacks) {
      let opened = false;
      const nativeWriter = new NativeAudioWriter(api, sessionId, (info) => {
        if (!opened) offsetMs = (info.saved_samples * 1000) / info.sample_rate;
        opened = true;
      }, true);
      writer = nativeWriter;
      unlisten = bridge.onNativeFailure((failure: NativeFailure) => {
        if (failure.sessionId !== sessionId || writer !== nativeWriter) return;
        if (failure.code === 'transcription_failed') {
          callbacks.onFailure(failure.reason ? `Recognition stopped: ${failure.reason.replace(/\.?$/, '.')}` : 'Recognition stopped.');
        } else {
          nativeWriter.disconnect();
          callbacks.onFailure('The local audio connection failed.');
        }
      });
      queue = new PersistenceQueue({
        store: (chunk) => nativeWriter.store(chunk),
        maxPending: 64,
        maxAttempts: 1,
        onBlocked: () => callbacks.onFailure('Audio delivery was interrupted; the audio received so far is kept.'),
      });
      const activeQueue = queue;
      const meter = new SignalMeter();
      recorder = new AudioRecorder({
        onReady: async (rate) => {
          await nativeWriter.open(rate);
          if (!nativeWriter.transcriptionAvailable) {
            throw new Error(nativeWriter.transcriptionDetail ?? 'Speech recognition isn’t available. Check Settings → Recording & speech.');
          }
        },
        onChunk: (chunk) => activeQueue.enqueue({ sequence: chunk.sequence, startMs: chunk.startMs, endMs: chunk.endMs, wav: chunk.wav }),
        onSignal: (sample) => {
          const snapshot = meter.push(sample.rms, sample.peak, sample.sampleCount, sample.sampleRate);
          if (snapshot) callbacks.onLevel(snapshot);
        },
        onError: (message) => callbacks.onFailure(message),
        onCaptureIncomplete: () => { incomplete = true; },
        onDisconnected: () => callbacks.onFailure('The microphone was disconnected. Captured audio was saved.'),
        onSystemAudioLost: () => callbacks.onFailure('Computer sound stopped; the microphone part is saved.'),
      }, { windowSeconds: 0.1, sampleRate });
      try {
        await recorder.start(sources);
      } catch (error) {
        unlisten?.();
        unlisten = null;
        throw error;
      }
    },
    async pause() {
      await recorder?.pause();
      if (await queue?.drain() ?? true) await writer?.finish('pause');
    },
    async resume(sources) {
      await recorder?.changeSources(sources);
      await writer?.open();
      await recorder?.resume();
    },
    async stop() {
      await recorder?.stop();
      const saved = await queue?.drain() ?? true;
      if (saved) {
        try { await writer?.finish('stop'); } catch { /* finalisation is settled by POST /kb/recordings/{id}/stop */ }
        unlisten?.();
        unlisten = null;
      }
      return saved;
    },
    incomplete() {
      return incomplete;
    },
    elapsedMs() {
      return offsetMs + (recorder?.elapsedMs() ?? 0);
    },
    pending() {
      const state = queue?.getState();
      return { pending: state?.pending ?? 0, failed: state?.failed.length ?? 0 };
    },
  };
}
