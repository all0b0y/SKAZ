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
    storeAudio: vi.fn(async () => ({ ok: true as const, status: 201, data: { sequence: 0, duplicate: false } })),
    fetchAudio: vi.fn(async () => ({ ok: true as const, status: 200, data: new ArrayBuffer(4) })),
    getBackendStatus: vi.fn(async () => ({ phase: 'ready' as const })),
    onBackendStatus: vi.fn(() => () => undefined),
    platform: 'test',
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
  it('creates an explicitly mode-bound session and maps contextual live endpoints', async () => {
    const { bridge, requests } = fakeBridge((req) => ({ ok: true, status: req.method === 'POST' ? 202 : 200, data: req.body ?? { capable: false } }));
    const api = new ApiClient(bridge);
    await api.createSession('Context', 'contextual_local');
    await api.getLiveAsrCapabilities();
    await api.getLiveAsr('session / one');
    await api.getLiveAsrScheduler('session / one');
    await api.advanceLiveAsr('session / one', 7);
    expect(requests).toEqual([
      { method: 'POST', path: '/sessions', body: { title: 'Context', mode: 'contextual_local' } },
      { method: 'GET', path: '/asr/live/capabilities' },
      { method: 'GET', path: '/sessions/session%20%2F%20one/asr/live' },
      { method: 'GET', path: '/sessions/session%20%2F%20one/asr/live/scheduler' },
      { method: 'POST', path: '/sessions/session%20%2F%20one/asr/live/advance', body: { through_sequence: 7 } },
    ]);
  });

  it('maps protected fragment read, edit, and acceptance CAS routes', async () => {
    const { bridge, requests } = fakeBridge((req) => ({
      ok: true,
      status: 200,
      data: req.method === 'GET' ? { fragments: [] } : req.body,
    }));
    const api = new ApiClient(bridge);
    await api.getLiveAsrFragments('session / one');
    await api.editLiveAsrFragment('session / one', 'fragment / one', {
      text: 'human text', expected_revision: 2, range_fingerprint: 'range-sha',
    });
    await api.acceptLiveAsrFragment('session / one', 'fragment / one', {
      expected_revision: 3, range_fingerprint: 'range-sha', idempotency_key: 'accept-1',
    });
    expect(requests).toEqual([
      { method: 'GET', path: '/sessions/session%20%2F%20one/asr/fragments' },
      {
        method: 'PUT', path: '/sessions/session%20%2F%20one/asr/fragments/fragment%20%2F%20one/text',
        body: { text: 'human text', expected_revision: 2, range_fingerprint: 'range-sha' },
      },
      {
        method: 'POST', path: '/sessions/session%20%2F%20one/asr/fragments/fragment%20%2F%20one/accept',
        body: { expected_revision: 3, range_fingerprint: 'range-sha', idempotency_key: 'accept-1' },
      },
    ]);
  });
  it('uses the narrow binary bridge for persistence-only storage', async () => {
    const { bridge } = fakeBridge(() => ({ ok: true, status: 200, data: null }));
    const wav = new Uint8Array([82, 73, 70, 70, 0, 0]).buffer;
    await new ApiClient(bridge).storeAudio('s1', { sequence: 3, startMs: 20, endMs: 30 }, wav);
    expect(bridge.storeAudio).toHaveBeenCalledWith('s1', { sequence: 3, startMs: 20, endMs: 30 }, wav);
    expect(bridge.uploadAudio).not.toHaveBeenCalled();
  });
  it('maps the paginated audio manifest to the exact authenticated bridge route', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { chunks: [], next_after_sequence: null },
    }));

    await new ApiClient(bridge).getAudioManifestPage('session / one', 12, 200);

    expect(requests).toEqual([{
      method: 'GET',
      path: '/sessions/session%20%2F%20one/audio',
      query: { after_sequence: 12, limit: 200 },
    }]);
  });

  it('omits the exclusive cursor on the first audio manifest page', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { chunks: [], next_after_sequence: null },
    }));

    await new ApiClient(bridge).getAudioManifestPage('s1', undefined, 100);

    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/sessions/s1/audio',
      query: { limit: 100 },
    });
  });

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

  it('maps local model status to the exact GET route and query', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { model: 'small', state: 'not_installed', error: null },
    }));

    await new ApiClient(bridge).getLocalModelStatus('local-whisper', 'small');

    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/models/local/status',
        query: { provider: 'local-whisper', model: 'small' },
      },
    ]);
  });

  it('maps explicit local model preparation to the exact POST route and body', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { model: 'small', state: 'loading', error: null },
    }));

    await new ApiClient(bridge).prepareLocalModel('local-whisper', 'small');

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/models/local/prepare',
        body: { provider: 'local-whisper', model: 'small' },
      },
    ]);
  });

  it('maps explicit local model deletion to the exact DELETE route and confirmation body', async () => {
    const { bridge, requests } = fakeBridge(() => ({
      ok: true,
      status: 200,
      data: { provider: 'local-whisper', model: 'small', state: 'not_installed', deleted: true },
    }));

    await new ApiClient(bridge).deleteLocalModel('local-whisper', 'small');

    expect(requests).toEqual([
      {
        method: 'DELETE',
        path: '/models/local',
        body: {
          provider: 'local-whisper',
          model: 'small',
          confirmation_model: 'small',
        },
      },
    ]);
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

  it('sends native recording preferences without changing consent or model assignments', async () => {
    const { bridge, requests } = fakeBridge(() => ({ ok: true, status: 200, data: {
      native_recording_mode: 'translation', translation_target_language: 'en',
    } }));
    const settings = await new ApiClient(bridge).updateSettings({
      native_recording_mode: 'translation', translation_target_language: 'en',
    });
    expect(requests).toEqual([{
      method: 'PUT', path: '/settings',
      body: { native_recording_mode: 'translation', translation_target_language: 'en' },
    }]);
    expect(settings.native_recording_mode).toBe('translation');
    expect(settings.translation_target_language).toBe('en');
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
      storeAudio: vi.fn(),
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
