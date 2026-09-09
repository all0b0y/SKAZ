// Standalone PCM16 mono WAV encoding. Each recorded window is encoded as a
// complete, independent RIFF/WAVE file so the backend can transcribe it on its
// own without a container-level dependency on neighbouring chunks (see
// docs/ARCHITECTURE.md — honest "chunked", not fake streaming).

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
const PCM_FORMAT = 1;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

const PCM16_MAX = 32767;
const PCM16_MIN = -32768;

/** Convert normalized float samples (-1..1) to clamped signed 16-bit PCM. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    if (Number.isNaN(sample)) {
      out[i] = 0;
      continue;
    }
    // Scale by the negative floor so full-scale +1.0 and -1.0 map symmetrically
    // to the representable range, then clamp rather than wrap on overflow.
    const scaled = Math.round(sample * -PCM16_MIN);
    out[i] = scaled > PCM16_MAX ? PCM16_MAX : scaled < PCM16_MIN ? PCM16_MIN : scaled;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Encode mono float samples into a complete PCM16 WAV ArrayBuffer. */
export function encodeWavPcm16Mono(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const pcm = floatToPcm16(samples);
  const dataBytes = pcm.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  const byteRate = sampleRate * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(offset, pcm[i]!, true);
    offset += BYTES_PER_SAMPLE;
  }

  return buffer;
}

export interface WavHeader {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
}

/** Read the fields the app cares about from a canonical 44-byte WAV header. */
export function readWavHeader(buffer: ArrayBuffer): WavHeader {
  const view = new DataView(buffer);
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  };
}
