import { describe, it, expect, vi } from 'vitest';
import { ApiClient, ApiError } from './client';
import type { BridgeApi, BridgeRequest, JsonResponse } from './bridge';

function fakeBridge(handler: (req: BridgeRequest) => JsonResponse<unknown>): {
  bridge: BridgeApi;
  requests: BridgeRequest[];
} {
  const requests: BridgeRequest[] = [];
  const bridge = {
    request: vi.fn(async (req: BridgeRequest) => {
      requests.push(req);
      return handler(req) as JsonResponse<never>;
    }),
    getBackendStatus: vi.fn(async () => ({ phase: 'ready' as const })),
    onBackendStatus: vi.fn(() => () => undefined),
  } as unknown as BridgeApi;
  return { bridge, requests };
}

describe('ApiClient request mapping', () => {
  it('uses the narrow native bridge for PCM and propagates durable-save failures', async () => {
    const { bridge } = fakeBridge(() => ({ ok: true, status: 200, data: null }));
    bridge.openNative = vi.fn<BridgeApi['openNative']>(async () => ({ ok: true, status: 200, data: {
      connection_id: 'native', sample_rate: 16000, saved_samples: 1600, next_sequence: 1, transcription: 'unavailable',
    } }));
    bridge.sendNativeAudio = vi.fn<BridgeApi['sendNativeAudio']>(async () => ({ ok: false, status: 0, detail: 'storage failed' }));
    bridge.endNative = vi.fn<BridgeApi['endNative']>(async () => ({ ok: true, status: 200, data: {
      saved_samples: 1600, transcription_complete: false, status: 'paused',
    } }));
    const api = new ApiClient(bridge);
    expect((await api.openNative('session', 16000)).next_sequence).toBe(1);
    const pcm = new ArrayBuffer(3200);
    await expect(api.sendNativeAudio('session', { sequence: 1, startSample: 1600 }, pcm)).rejects.toThrow('storage failed');
    expect(bridge.sendNativeAudio).toHaveBeenCalledWith('session', { sequence: 1, startSample: 1600 }, pcm);
    expect((await api.endNative('session', 'pause')).status).toBe('paused');
  });

  it('does not include a title when only setting status', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { id: 's1', title: 'A', created_at: 't', status: 'paused', duration_ms: 0 },
    }));
    await new ApiClient(bridge).setSessionStatus('s1', 'paused');
    expect(requests[0]!.body).toEqual({ status: 'paused' });
  });

  it('sends the explicit capture-only status option on the wire', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { id: 's1', title: 'A', created_at: 't', status: 'stopped', duration_ms: 1 },
    }));
    await new ApiClient(bridge).setSessionStatus('s1', 'stopped', { flush_transcription: false });
    expect(requests[0]!.body).toEqual({ status: 'stopped', flush_transcription: false });
  });
});

describe('ApiClient error handling', () => {
  it('throws ApiError with status and detail on non-ok responses', async () => {
    const { bridge } = fakeBridge(() => ({ ok: false, status: 422, detail: 'incompatible ASR model' }));
    await expect(new ApiClient(bridge).setSessionStatus('s1', 'paused')).rejects.toBeInstanceOf(ApiError);
    await expect(new ApiClient(bridge).setSessionStatus('s1', 'paused')).rejects.toMatchObject({
      status: 422,
      message: 'incompatible ASR model',
    });
  });
});
