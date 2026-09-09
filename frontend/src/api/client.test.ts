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
    uploadAudio: vi.fn(async () => ({ ok: true as const, status: 200, data: { duplicate: false, segments: [] } })),
    fetchAudio: vi.fn(async () => ({ ok: true as const, status: 200, data: new ArrayBuffer(4) })),
    getBackendStatus: vi.fn(async () => ({ phase: 'ready' as const })),
    onBackendStatus: vi.fn(() => () => undefined),
    platform: 'test',
  } as unknown as BridgeApi;
  return { bridge, requests };
}

describe('ApiClient request mapping', () => {
  it('lists sessions from the {sessions:[]} envelope', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { sessions: [{ id: 's1', title: 'A', created_at: 't', status: 'stopped', duration_ms: 0 }] },
    }));
    const sessions = await new ApiClient(bridge).listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('s1');
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/sessions' });
  });

  it('sends model catalog query params', async () => {
    const { bridge, requests } = fakeBridge(() => ({ ok: true, status: 200, data: { models: [] } }));
    await new ApiClient(bridge).getModels('openrouter', 'agent');
    expect(requests[0]).toMatchObject({
      method: 'GET',
      path: '/models',
      query: { provider: 'openrouter', task: 'agent' },
    });
  });

  it('encodes ask requests with window and scope', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { answer: 'x', citations: [], context: { start_ms: 0, end_ms: 1, scope: 'recent' }, model: 'm' },
    }));
    await new ApiClient(bridge).ask('s1', { question: 'what did I miss', window_minutes: 5, scope: 'recent' });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/sessions/s1/ask',
      body: { question: 'what did I miss', window_minutes: 5, scope: 'recent' },
    });
  });

  it('sends settings updates as PUT with the partial body (api_key write-only)', async () => {
    const { bridge, requests } = fakeBridge((req) => ({ ok: true, status: 200, data: req.body }));
    await new ApiClient(bridge).updateSettings({ agent: { provider: 'openrouter', api_key: 'secret' } });
    expect(requests[0]!.method).toBe('PUT');
    expect(requests[0]!.body).toEqual({ agent: { provider: 'openrouter', api_key: 'secret' } });
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
});

describe('ApiClient error handling', () => {
  it('throws ApiError with status and detail on non-ok responses', async () => {
    const { bridge } = fakeBridge(() => ({ ok: false, status: 422, detail: 'incompatible ASR model' }));
    await expect(new ApiClient(bridge).getSettings()).rejects.toBeInstanceOf(ApiError);
    await expect(new ApiClient(bridge).getSettings()).rejects.toMatchObject({
      status: 422,
      message: 'incompatible ASR model',
    });
  });

  it('propagates upload failures as ApiError', async () => {
    const bridge: BridgeApi = {
      request: vi.fn(),
      uploadAudio: vi.fn(async () => ({ ok: false, status: 409, detail: 'sequence reuse' })),
      fetchAudio: vi.fn(),
      getBackendStatus: vi.fn(),
      onBackendStatus: vi.fn(),
      platform: 'test',
    } as unknown as BridgeApi;
    await expect(
      new ApiClient(bridge).uploadAudio('s1', { sequence: 1, startMs: 0, endMs: 5000 }, new ArrayBuffer(8)),
    ).rejects.toMatchObject({ status: 409 });
  });
});
