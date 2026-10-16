import { FLOOR_DBFS, linearToDbfs } from '../../audio/meter';

/**
 * A live input level for Settings → Microphone: the chosen input is opened with `getUserMedia`
 * (audio only) and measured with an AnalyserNode, nothing is recorded or sent anywhere. The caller
 * closes it as soon as the row is out of sight or Settings closes — the system microphone
 * indicator must not stay lit for a settings page.
 */
export interface MicLevelSource {
  /** Opens the input; rejects like `getUserMedia` (NotAllowedError when access is off). */
  open(deviceId: string, onLevel: (level: number) => void): Promise<() => void>;
}

const INTERVAL_MS = 100;
const SILENCE_DBFS = -55;

/** 0..1 from a linear RMS: silence at the floor, full at about −6 dBFS. No gain, no smoothing tricks. */
export function levelFromRms(rms: number): number {
  const dbfs = linearToDbfs(rms);
  if (dbfs <= Math.max(FLOOR_DBFS, SILENCE_DBFS)) return 0;
  return Math.min(1, (dbfs - SILENCE_DBFS) / (-6 - SILENCE_DBFS));
}

/** Measures an already opened stream until the returned stop is called (which closes the stream too). */
function measure(stream: MediaStream, onLevel: (level: number) => void): () => void {
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => undefined);
    context = null;
  };
  try {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      onLevel(levelFromRms(Math.sqrt(sum / samples.length)));
    }, INTERVAL_MS);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

export const browserMicLevel: MicLevelSource = {
  async open(deviceId, onLevel) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    return measure(stream, onLevel);
  },
};

/**
 * The level of the computer's own sound, for the Computer audio check: the same whole-system
 * loopback the recording uses (`getDisplayMedia`, audio only — main grants nothing else). macOS
 * keeps this permission under "System Audio Recording Only", which no API can read beforehand, so
 * the only honest answer is to listen for a moment. Rejects like `getDisplayMedia`.
 */
export interface SystemAudioLevelSource {
  open(onLevel: (level: number) => void): Promise<() => void>;
}

export const browserSystemAudioLevel: SystemAudioLevelSource = {
  async open(onLevel) {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    stream.getVideoTracks().forEach((track) => track.stop());
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      stream.getTracks().forEach((track) => track.stop());
      throw Object.assign(new Error('macOS gave SKAZ no computer audio.'), { name: 'NotReadableError' });
    }
    return measure(stream, onLevel);
  },
};
