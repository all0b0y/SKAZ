import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import type { BridgeApi } from '../api/bridge';
import { encodeWavPcm16Mono } from './wav';
import { NativeAudioWriter } from './nativeWriter';

function fixture(retainAudio = true) {
  let samples = 0;
  let sequence = 0;
  let loseAck = false;
  const sent: number[] = [];
  const bridge: BridgeApi = {
    ...window.audiohelper,
    openNative: vi.fn<BridgeApi['openNative']>(async (_id, rate) => ({ ok: true, status: 200, data: {
      audio_retained: retainAudio, connection_id: 'fixture', sample_rate: rate, saved_samples: samples, next_sequence: sequence, transcription: 'unavailable',
    } })),
    sendNativeAudio: vi.fn<BridgeApi['sendNativeAudio']>(async (_id, meta, pcm) => {
      sent.push(meta.sequence);
      if (meta.sequence !== sequence || meta.startSample !== samples) throw new Error('wrong clock');
      samples += pcm.byteLength / 2;
      sequence += 1;
      if (loseAck) { loseAck = false; return { ok: false, status: 0, detail: 'ack lost' }; }
      return { ok: true, status: 200, data: { sequence: meta.sequence, saved_samples: samples, duplicate: false } };
    }),
    endNative: vi.fn<BridgeApi['endNative']>(async (_id, action) => ({ ok: true, status: 200, data: {
      saved_samples: samples, status: action === 'pause' ? 'paused' : 'stopped', transcription_complete: false,
    } })),
  };
  return { writer: new NativeAudioWriter(new ApiClient(bridge), 'session'), bridge, sent, loseAck: () => { loseAck = true; } };
}
const chunk = (sequence: number) => ({ sequence, startMs: sequence * 100, endMs: (sequence + 1) * 100,
  wav: encodeWavPcm16Mono(new Float32Array(1600).fill(0.25), 16000) });

describe('native writer at the renderer bridge boundary', () => {
  it('appends to an explicitly reopened recording without resetting its clock, including ACK recovery', async () => {
    const f = fixture();
    await f.writer.open(16000);
    await f.writer.store(chunk(0));
    await f.writer.finish('stop');
    const reopened = new NativeAudioWriter(new ApiClient(f.bridge), 'session', undefined, true);
    await reopened.open(16000);
    f.loseAck();
    await expect(reopened.store(chunk(0))).rejects.toThrow('ack lost');
    await reopened.open();
    expect((await reopened.store(chunk(0))).duplicate).toBe(true);
    await reopened.store(chunk(1));
    await reopened.finish('stop');
    expect(f.sent).toEqual([0, 1, 2]);
    expect(f.bridge.sendNativeAudio).toHaveBeenLastCalledWith('session', { sequence: 2, startSample: 3200 }, expect.any(ArrayBuffer));
  });

  it('continues sample clock across pause and resume and finishes once', async () => {
    const f = fixture();
    await f.writer.open(16000);
    await f.writer.store(chunk(0));
    await f.writer.finish('pause');
    await f.writer.open(16000);
    await f.writer.store(chunk(1));
    await Promise.all([f.writer.finish('stop'), f.writer.finish('stop')]);
    expect(f.bridge.sendNativeAudio).toHaveBeenLastCalledWith('session', { sequence: 1, startSample: 1600 }, expect.any(ArrayBuffer));
    expect(f.bridge.endNative).toHaveBeenCalledTimes(2);
  });

  it('does not silently finalize a stream whose opening failed', async () => {
    const f = fixture();
    vi.mocked(f.bridge.openNative).mockResolvedValueOnce({ ok: false, status: 503, detail: 'offline' });
    await expect(f.writer.open(16000)).rejects.toThrow('offline');
    await expect(f.writer.finish('stop')).rejects.toThrow('explicit reconnect/retry');
    expect(f.bridge.endNative).not.toHaveBeenCalled();
  });

  it('reconciles a lost durable ACK only on explicit reopen and does not resend saved PCM', async () => {
    const f = fixture();
    await f.writer.open(16000);
    f.loseAck();
    await expect(f.writer.store(chunk(0))).rejects.toThrow('ack lost');
    await f.writer.open(16000);
    expect((await f.writer.store(chunk(0))).duplicate).toBe(true);
    await f.writer.store(chunk(1));
    expect(f.sent).toEqual([0, 1]);
    await f.writer.finish('stop');
  });
});

it('reports transport acceptance without claiming a saved audio source', async () => {
  const f = fixture(false);
  await f.writer.open(16000);
  expect(await f.writer.store(chunk(0))).toMatchObject({ available: false, source_kind: 'transient_pcm' });
  await f.writer.finish('stop');
});
