// Dictation capture (decision: "dictation in chat is text only"): microphone → one WAV clip →
// bridge.dictate → text in the field. Nothing is stored. The clip is PCM16 mono 16 kHz, at most
// 120 s (the backend limit), reusing the app's WAV encoder (frontend/src/audio/wav.ts).

import { encodeWavPcm16Mono } from '../../audio/wav';

export const DICTATION_MAX_S = 120;
const TARGET_RATE = 16_000;

export interface Capture {
  /** Stop and return the clip. */
  stop: () => Promise<{ wav: ArrayBuffer; seconds: number }>;
  /** Stop and throw everything away. */
  cancel: () => void;
}

export class DictationError extends Error {}

/** Mixed-down, resampled mono samples of a decoded clip. */
async function toMono16k(buffer: AudioBuffer): Promise<Float32Array> {
  const frames = Math.max(1, Math.ceil(buffer.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Start the microphone. Rejects with a plain reason when it cannot. */
export async function startCapture(): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new DictationError('This window can’t use the microphone.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    throw new DictationError('Microphone access was refused. Allow it in System Settings → Privacy → Microphone.');
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start();
  const started = performance.now();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stop: () => new Promise((resolve, reject) => {
      recorder.onstop = async () => {
        release();
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          const ctx = new AudioContext();
          const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
          void ctx.close();
          const samples = await toMono16k(decoded);
          const limited = samples.subarray(0, DICTATION_MAX_S * TARGET_RATE);
          resolve({ wav: encodeWavPcm16Mono(limited, TARGET_RATE), seconds: (performance.now() - started) / 1000 });
        } catch {
          reject(new DictationError('The recording couldn’t be read. Try again.'));
        }
      };
      recorder.stop();
    }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
