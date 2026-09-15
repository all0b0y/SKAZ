import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { NativeLiveClient } from '../../../electron/nativeLive';

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(acknowledge = true, transcription = 'unavailable') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('missing test address');
  const frames: Buffer[] = [];
  let endCount = 0;
  let headers: string | undefined;
  server.on('connection', (socket, request) => {
    headers = request.headers.authorization;
    socket.on('message', (bytes, binary) => {
      if (binary) {
        const frame = Buffer.from(bytes as Buffer);
        frames.push(frame);
        if (acknowledge) socket.send(JSON.stringify({ type: 'audio.saved', sequence: Number(frame.readBigUInt64BE()),
          saved_samples: Number(frame.readBigUInt64BE(8)) + frame.readUInt32BE(16), duplicate: false }));
      } else {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'open') socket.send(JSON.stringify({ type: 'stream.opened', connection_id: 'fixture',
          sample_rate: message.sample_rate, saved_samples: 0, next_sequence: 0, transcription }));
        else {
          endCount += 1;
          socket.send(JSON.stringify({ type: 'stream.stopped', saved_samples: 1600,
            transcription_complete: false, status: message.action === 'pause' ? 'paused' : 'stopped' }));
        }
      }
    });
  });
  const failed = vi.fn();
  const client = new NativeLiveClient(() => ({ port: address.port, token: 'fixture-only' }), failed);
  return { client, frames, server, failed, endCount: () => endCount, headers: () => headers };
}

describe('main-owned native live transport', () => {
  it('accepts intentionally disabled transcription without treating local capture as a failure', async () => {
    const f = await fixture(true, 'disabled');
    expect(await f.client.open('session', 16000)).toMatchObject({ transcription: 'disabled' });
    expect(await f.client.audio('session', { sequence: 0, startSample: 0 }, new ArrayBuffer(3200)))
      .toMatchObject({ saved_samples: 1600 });
    expect(await f.client.end('session', 'stop')).toMatchObject({ transcription_complete: false });
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('bounds queued PCM to two seconds and rejects pending writes on disconnect', async () => {
    const f = await fixture(false);
    await f.client.open('session', 16000);
    const pending = Array.from({ length: 4 }, (_, sequence) =>
      f.client.audio('session', { sequence, startSample: sequence * 8000 }, new ArrayBuffer(16000)));
    const settled = Promise.allSettled(pending);
    await expect(f.client.audio('session', { sequence: 4, startSample: 32000 }, new ArrayBuffer(16000)))
      .rejects.toThrow('queue is full');
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    // No further frame is sent before an actual audio.saved ACK.
    for (const socket of f.server.clients) socket.close();
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
    expect(f.failed).toHaveBeenCalledTimes(1);
  });

  it('reports an unsolicited storage failure during idle capture without leaking remote text', async () => {
    const f = await fixture();
    await f.client.open('session', 16000);
    for (const socket of f.server.clients) socket.send(JSON.stringify({
      type: 'stream.error', code: 'storage_failed', detail: 'private server content',
    }));
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledWith({ sessionId: 'session', code: 'storage_failed' }));
    await expect(f.client.end('session', 'stop')).rejects.toThrow();
    expect(JSON.stringify(f.failed.mock.calls)).not.toContain('private server content');
  });

  it('authenticates, frames exact PCM, waits for saved ACK, and finishes once', async () => {
    const f = await fixture();
    expect(await f.client.open('session', 16000)).toMatchObject({ saved_samples: 0, transcription: 'unavailable' });
    const pcm = new ArrayBuffer(3200);
    new DataView(pcm).setInt16(0, -123, true);
    const saved = f.client.audio('session', { sequence: 0, startSample: 0 }, pcm);
    const end = f.client.end('session', 'pause');
    expect(await saved).toMatchObject({ saved_samples: 1600 });
    expect(await end).toMatchObject({ status: 'paused', transcription_complete: false });
    expect(await f.client.end('session', 'pause')).toEqual(await end);
    expect(f.endCount()).toBe(1);
    expect(f.headers()).toBe('Bearer fixture-only');
    expect(f.frames[0]?.length).toBe(3220);
    expect(f.frames[0]?.readInt16LE(20)).toBe(-123);
  });

  it('rejects unsafe input, a second owner, and PCM after end', async () => {
    const f = await fixture();
    await expect(f.client.open('../escape', 16000)).rejects.toThrow();
    await f.client.open('session', 16000);
    await expect(f.client.open('other', 16000)).rejects.toThrow();
    await expect(f.client.audio('other', { sequence: 0, startSample: 0 }, new ArrayBuffer(3200))).rejects.toThrow();
    await expect(f.client.audio('session', { sequence: 0, startSample: 0 }, new ArrayBuffer(16002))).rejects.toThrow();
    await f.client.end('session', 'stop');
    await expect(f.client.audio('session', { sequence: 1, startSample: 1600 }, new ArrayBuffer(3200))).rejects.toThrow();
  });
});
