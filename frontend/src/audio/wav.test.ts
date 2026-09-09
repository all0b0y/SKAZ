import { describe, it, expect } from 'vitest';
import { encodeWavPcm16Mono, floatToPcm16, readWavHeader } from './wav';

const readAscii = (view: DataView, offset: number, length: number): string => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
};

describe('floatToPcm16', () => {
  it('maps 0 to 0', () => {
    const pcm = floatToPcm16(Float32Array.of(0));
    expect(pcm[0]).toBe(0);
  });

  it('maps +1.0 to 32767 and -1.0 to -32768', () => {
    const pcm = floatToPcm16(Float32Array.of(1, -1));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const pcm = floatToPcm16(Float32Array.of(2, -2, 1.5, -1.5));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(32767);
    expect(pcm[3]).toBe(-32768);
  });

  it('leaves NaN as silence', () => {
    const pcm = floatToPcm16(Float32Array.of(NaN));
    expect(pcm[0]).toBe(0);
  });
});

describe('encodeWavPcm16Mono', () => {
  it('produces a standalone 44-byte-header RIFF/WAVE file', () => {
    const samples = Float32Array.of(0, 0.5, -0.5, 1);
    const buffer = encodeWavPcm16Mono(samples, 16000);
    const view = new DataView(buffer);

    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(readAscii(view, 8, 4)).toBe('WAVE');
    expect(readAscii(view, 12, 4)).toBe('fmt ');
    expect(readAscii(view, 36, 4)).toBe('data');
    // header (44) + 4 samples * 2 bytes
    expect(buffer.byteLength).toBe(44 + 8);
  });

  it('writes PCM16 mono format fields for the given sample rate', () => {
    const buffer = encodeWavPcm16Mono(Float32Array.of(0, 0), 48000);
    const view = new DataView(buffer);
    const header = readWavHeader(buffer);

    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(header.channels).toBe(1);
    expect(header.sampleRate).toBe(48000);
    expect(header.bitsPerSample).toBe(16);
    expect(view.getUint16(32, true)).toBe(2); // block align = channels * bytesPerSample
    expect(view.getUint32(28, true)).toBe(48000 * 2); // byte rate
  });

  it('encodes RIFF and data chunk sizes consistent with the sample count', () => {
    const samples = Float32Array.of(0.1, 0.2, 0.3);
    const buffer = encodeWavPcm16Mono(samples, 16000);
    const view = new DataView(buffer);
    const dataBytes = samples.length * 2;

    expect(view.getUint32(4, true)).toBe(36 + dataBytes); // RIFF chunk size
    expect(view.getUint32(40, true)).toBe(dataBytes); // data chunk size
  });

  it('round-trips endpoint samples through the header reader', () => {
    const samples = Float32Array.of(1, -1);
    const buffer = encodeWavPcm16Mono(samples, 16000);
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(readWavHeader(buffer).dataBytes).toBe(4);
  });

  it('produces an empty but valid file for zero samples', () => {
    const buffer = encodeWavPcm16Mono(new Float32Array(0), 16000);
    expect(buffer.byteLength).toBe(44);
    expect(readWavHeader(buffer).dataBytes).toBe(0);
  });
});
