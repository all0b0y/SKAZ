import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../api/bridge';
import type { Note, Session, Settings } from '../api/types';
import { FLOOR_DBFS } from '../audio/meter';

import { useStore } from './store';

const settings = (over: Partial<Settings> = {}): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' },
  agent: { provider: 'openrouter', model: 'agent' },
  notes: { provider: 'openrouter', model: 'notes' },
  transcript_language: 'auto',
  output_language: 'ru',
  cloud_consent: false,
  contextual_local_enabled: false,
  ...over,
});

const session = (id: string, status: Session['status'] = 'stopped'): Session => ({
  id,
  title: id,
  created_at: '2026-09-06T00:00:00Z',
  status,
  duration_ms: status === 'stopped' ? 60_000 : 0,
  mode: 'legacy',
});

// Replace only `request` with a plain mock; keeping BridgeApi's generic
// `request` signature in the intersection makes the mock unassignable.
const bridge = window.audiohelper as unknown as Omit<BridgeApi, 'request'> & {
  request: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    if (req.method === 'POST' && req.path === '/sessions') {
      return {
        ok: true,
        status: 200,
        data: { ...session('new-session'), mode: (req.body as { mode?: string })?.mode ?? 'legacy' },
      };
    }
    if (req.method === 'GET' && req.path === '/sessions/new-session') {
      return {
        ok: true,
        status: 200,
        data: { session: session('new-session'), segments: [], messages: [], notes: null },
      };
    }
    if (req.method === 'GET' && req.path.endsWith('/audio')) {
      return { ok: true, status: 200, data: { chunks: [], next_after_sequence: null } };
    }
    if (req.method === 'GET' && req.path === '/sessions') {
      return { ok: true, status: 200, data: { sessions: [] } };
    }
    if (req.method === 'PATCH') {
      return { ok: true, status: 200, data: session(req.path.split('/').at(-1)!, 'recording') };
    }
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
  useStore.setState({
    settings: settings(),
    sessions: [],
    activeSessionId: null,
    detail: null,
    quitRequested: false,
    captureIncomplete: false,
    recorderState: 'idle',
    recorderError: null,
    meter: {
      dbfs: FLOOR_DBFS,
      peakDbfs: FLOOR_DBFS,
      clipping: false,
      sustainedLow: false,
      vad: 'unavailable',
    },
    queue: {
      pending: 0,
      inFlight: null,
      completed: 0,
      duplicates: 0,
      failed: [],
      droppedCount: 0,
      overflow: false,
      lastError: null,
    },
    transcription: {
      pending: 0,
      inFlight: null,
      completed: 0,
      failed: [],
      deferred: 0,
      diskFailed: 0,
      blockedByConsent: false,
      lastError: null,
    },
    nextRecordingMode: 'legacy',
    liveCapabilities: {
      mode: 'contextual_local', capable: false,
      requirements: { local_profile_selected: true, contextual_local_enabled: false, live_finality_enabled: false, local_speech_gate_enabled: false },
      detail: 'disabled',
    },
    liveDraft: null,
    liveFragments: [],
    liveSourceIntegrity: null,
    liveResumeCompatibility: null,
    liveScheduler: null,
    liveError: null,
    pendingSessionStatus: null,
    pendingSessionStatusSessionId: null,
    asking: false,
    askError: null,
    notesGenerating: false,
    notesError: null,
  });
  Object.assign(window.audiohelper, { storeAudio: vi.fn(async (_sessionId: string, meta: { sequence: number; startMs: number; endMs: number }) => ({
    ok: true,
    status: 201,
    data: {
      sequence: meta.sequence,
      start_ms: meta.startMs,
      end_ms: meta.endMs,
      status: 'pending',
      available: true,
      duplicate: false,
      source_kind: 'original_captured_wav',
    },
  })), uploadAudio: vi.fn(async () => ({
    ok: true,
    status: 200,
    data: { duplicate: true, segments: [] },
  })), fetchAudio: vi.fn(async () => ({ ok: true, status: 200, data: new ArrayBuffer(4) })) });
});

describe('async session isolation', () => {
  it('installs each fulfilled contextual GET without waiting for a slow sibling', async () => {
    let resolveScheduler!: (value: JsonResponse<unknown>) => void;
    const contextSession = { ...session('independent-refresh'), mode: 'contextual_local' as const };
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.path.endsWith('/asr/live/scheduler')) {
        return new Promise((resolve) => { resolveScheduler = resolve; });
      }
      if (req.path.endsWith('/asr/live')) {
        return { ok: true, status: 200, data: { draft: { text: 'fulfilled first' } } };
      }
      if (req.path === '/sessions/independent-refresh') {
        return { ok: true, status: 200, data: { session: contextSession, segments: [], messages: [], notes: null } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({ sessions: [contextSession], activeSessionId: contextSession.id });

    const refresh = useStore.getState().refreshContextualLive(contextSession.id);
    await vi.waitFor(() => expect(useStore.getState().liveDraft?.text).toBe('fulfilled first'));
    resolveScheduler({
      ok: true,
      status: 200,
      data: {
        capable: true, accepted_count: 0, status: 'idle', captured_target_sequence: null,
        processed_window: null, stable_frontier_ms: 0, lag_ms: null, block_reason: null,
      },
    });
    await refresh;
  });

  it('restores a saved draft even when the adjacent scheduler status request fails', async () => {
    const contextSession = { ...session('draft-restore'), mode: 'contextual_local' as const };
    const persistedDraft = {
      state: 'draft' as const,
      revision: 3,
      epoch: 1,
      updated_at: '2026-09-11T00:00:00Z',
      text: 'saved draft survives partial refresh',
      text_scope: 'unstable_tail' as const,
      language: 'en',
      provider: 'local-whisper' as const,
      model: 'small',
      requested_language: 'auto',
      speech_gate_enabled: true,
      source_fingerprint: 'source',
      config_fingerprint: 'config',
      config_revision: 1,
      window: {
        start_ms: 0, end_ms: 1_000, sample_rate: 16_000, sample_count: 16_000,
        model_input_sample_rate: 16_000, model_input_sample_count: 16_000,
        model_input_kind: 'assembled_pcm16_mono_resampled_for_local_whisper' as const,
      },
      sources: [],
    };
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/draft-restore') {
        return { ok: true, status: 200, data: { session: contextSession, segments: [], messages: [], notes: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/draft-restore/audio') {
        return { ok: true, status: 200, data: { chunks: [], next_after_sequence: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/draft-restore/asr/live') {
        return { ok: true, status: 200, data: { draft: persistedDraft } };
      }
      if (req.method === 'GET' && req.path === '/sessions/draft-restore/asr/live/scheduler') {
        return { ok: false, status: 503, detail: 'scheduler status temporarily unavailable' };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({ sessions: [contextSession] });

    await useStore.getState().selectSession('draft-restore');
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledWith({
      method: 'GET', path: '/sessions/draft-restore/asr/live/scheduler',
    }));

    expect(useStore.getState().liveDraft?.text).toBe('saved draft survives partial refresh');
    await vi.waitFor(() => expect(useStore.getState().liveError).toMatch(/scheduler status temporarily unavailable/i));
  });

  it('explicit resume retries a notifier that previously failed', async () => {
    const contextSession = { ...session('resume-after-failure'), mode: 'contextual_local' as const };
    let attempts = 0;
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/resume-after-failure/audio') {
        return {
          ok: true,
          status: 200,
          data: {
            chunks: [{ sequence: 7, start_ms: 0, end_ms: 1_000, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' }],
            next_after_sequence: null,
          },
        };
      }
      if (req.method === 'POST' && req.path === '/sessions/resume-after-failure/asr/live/advance') {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 502, detail: 'decoder failed once' };
        return {
          ok: true,
          status: 202,
          data: {
            accepted: true,
            scheduler: {
              capable: true, accepted_count: 1, status: 'scheduled', captured_target_sequence: 7,
              processed_window: null, stable_frontier_ms: 0, lag_ms: 1_000, block_reason: null,
            },
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({
      sessions: [contextSession],
      activeSessionId: contextSession.id,
      liveCapabilities: {
        mode: 'contextual_local', capable: true,
        requirements: { local_profile_selected: true, contextual_local_enabled: true, live_finality_enabled: true, local_speech_gate_enabled: true },
        detail: 'available',
      },
    });

    await useStore.getState().resumeContextualProcessing();
    await vi.waitFor(() => expect(useStore.getState().liveError).toMatch(/decoder failed once/i));
    await useStore.getState().resumeContextualProcessing();

    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(useStore.getState().liveError).toBeNull();
  });

  it('keeps manifest failures visible and rejects repeated cursors without advancing', async () => {
    const contextSession = { ...session('bad-manifest'), mode: 'contextual_local' as const };
    let manifestAttempt = 0;
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/bad-manifest/audio') {
        manifestAttempt += 1;
        if (manifestAttempt === 1) {
          return { ok: false, status: 503, detail: 'manifest unavailable' };
        }
        return {
          ok: true,
          status: 200,
          data: {
            chunks: [{ sequence: 0, start_ms: 0, end_ms: 1_000, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' }],
            next_after_sequence: 0,
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({
      sessions: [contextSession], activeSessionId: contextSession.id,
      liveCapabilities: {
        mode: 'contextual_local', capable: true,
        requirements: { local_profile_selected: true, contextual_local_enabled: true, live_finality_enabled: true, local_speech_gate_enabled: true },
        detail: 'available',
      },
    });

    await useStore.getState().resumeContextualProcessing();
    expect(useStore.getState().liveError).toMatch(/manifest unavailable/i);
    await useStore.getState().resumeContextualProcessing();
    expect(useStore.getState().liveError).toMatch(/repeated cursor/i);
    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
  });

  it('drops a stale manifest walk before it can replace the selected session notifier', async () => {
    const first = { ...session('context-a'), mode: 'contextual_local' as const };
    const second = { ...session('context-b'), mode: 'contextual_local' as const };
    let resolveFirstManifest!: (value: JsonResponse<unknown>) => void;
    let resolveSecondAdvance!: (value: JsonResponse<unknown>) => void;
    bridge.request = vi.fn((req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/context-a/audio') {
        return new Promise((resolve) => { resolveFirstManifest = resolve; });
      }
      if (req.method === 'GET' && req.path === '/sessions/context-b') {
        return Promise.resolve({ ok: true, status: 200, data: { session: second, segments: [], messages: [], notes: null } });
      }
      if (req.method === 'GET' && req.path === '/sessions/context-b/audio') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            chunks: [{ sequence: 8, start_ms: 0, end_ms: 1_000, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' }],
            next_after_sequence: null,
          },
        });
      }
      if (req.method === 'GET' && req.path === '/sessions/context-b/asr/live') {
        return Promise.resolve({ ok: true, status: 200, data: { draft: null } });
      }
      if (req.method === 'GET' && req.path === '/sessions/context-b/asr/live/scheduler') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { capable: true, accepted_count: 0, status: 'idle', captured_target_sequence: null, processed_window: null, stable_frontier_ms: 0, lag_ms: null, block_reason: null },
        });
      }
      if (req.method === 'GET' && req.path === '/sessions/context-b/asr/fragments') {
        return Promise.resolve({ ok: true, status: 200, data: { fragments: [] } });
      }
      if (req.method === 'POST' && req.path === '/sessions/context-b/asr/live/advance') {
        return new Promise((resolve) => { resolveSecondAdvance = resolve; });
      }
      if (req.method === 'POST' && req.path === '/sessions/context-a/asr/live/advance') {
        return Promise.resolve({
          ok: true,
          status: 202,
          data: { accepted: true, scheduler: { capable: true, accepted_count: 1, status: 'scheduled', captured_target_sequence: 4, processed_window: null, stable_frontier_ms: 0, lag_ms: 1_000, block_reason: null } },
        });
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({
      sessions: [first, second],
      activeSessionId: first.id,
      liveCapabilities: {
        mode: 'contextual_local', capable: true,
        requirements: { local_profile_selected: true, contextual_local_enabled: true, live_finality_enabled: true, local_speech_gate_enabled: true },
        detail: 'available',
      },
    });

    const staleResume = useStore.getState().resumeContextualProcessing();
    await vi.waitFor(() => expect(resolveFirstManifest).toBeTypeOf('function'));
    await useStore.getState().selectSession(second.id);
    const currentResume = useStore.getState().resumeContextualProcessing();
    await vi.waitFor(() => expect(resolveSecondAdvance).toBeTypeOf('function'));
    resolveFirstManifest({
      ok: true,
      status: 200,
      data: {
        chunks: [{ sequence: 4, start_ms: 0, end_ms: 1_000, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' }],
        next_after_sequence: null,
      },
    });
    await staleResume;
    await currentResume;

    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/sessions/context-a/asr/live/advance',
    }));
    expect(bridge.request.mock.calls.filter(([req]) => (
      req.method === 'POST' && req.path === '/sessions/context-b/asr/live/advance'
    ))).toHaveLength(1);
    resolveSecondAdvance({
      ok: true,
      status: 202,
      data: { accepted: true, scheduler: { capable: true, accepted_count: 1, status: 'scheduled', captured_target_sequence: 8, processed_window: null, stable_frontier_ms: 0, lag_ms: 1_000, block_reason: null } },
    });
  });

  it('reopens contextual state with GET only and advances only after explicit resume', async () => {
    const contextSession = { ...session('context'), mode: 'contextual_local' as const };
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/context') {
        return { ok: true, status: 200, data: { session: contextSession, segments: [], messages: [], notes: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/context/audio') {
        return { ok: true, status: 200, data: { chunks: [{ sequence: 5, start_ms: 0, end_ms: 10, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' }], next_after_sequence: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/context/asr/live') {
        return { ok: true, status: 200, data: { draft: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/context/asr/live/scheduler') {
        return { ok: true, status: 200, data: { capable: true, accepted_count: 0, status: 'idle', captured_target_sequence: null, processed_window: null, stable_frontier_ms: 0, lag_ms: null, block_reason: null } };
      }
      if (req.method === 'POST' && req.path === '/sessions/context/asr/live/advance') {
        return { ok: true, status: 202, data: { accepted: true, scheduler: { capable: true, accepted_count: 1, status: 'scheduled', captured_target_sequence: 5, processed_window: null, stable_frontier_ms: 0, lag_ms: 10, block_reason: null } } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({
      sessions: [contextSession],
      liveCapabilities: { mode: 'contextual_local', capable: true, requirements: { local_profile_selected: true, contextual_local_enabled: true, live_finality_enabled: true, local_speech_gate_enabled: true }, detail: 'available' },
    });
    await useStore.getState().selectSession('context');
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ method: 'GET', path: '/sessions/context/asr/live' }));
    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
    await useStore.getState().resumeContextualProcessing();
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ method: 'POST', path: '/sessions/context/asr/live/advance', body: { through_sequence: 5 } }));
    expect(window.audiohelper.uploadAudio).not.toHaveBeenCalled();
  });

  it('drops a stale contextual snapshot after the selected session changes', async () => {
    let resolveLive!: (value: JsonResponse<unknown>) => void;
    const contextSession = { ...session('context'), mode: 'contextual_local' as const };
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.path.endsWith('/asr/live')) return new Promise((resolve) => { resolveLive = resolve; });
      if (req.path.endsWith('/asr/live/scheduler')) return { ok: true, status: 200, data: { capable: true, accepted_count: 0, status: 'idle', captured_target_sequence: null, processed_window: null, stable_frontier_ms: 0, lag_ms: null, block_reason: null } };
      if (req.path === '/sessions/context') return { ok: true, status: 200, data: { session: contextSession, segments: [], messages: [], notes: null } };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({ sessions: [contextSession], activeSessionId: 'context', liveDraft: null });
    const refresh = useStore.getState().refreshContextualLive('context');
    useStore.setState({ activeSessionId: 'other' });
    resolveLive({ ok: true, status: 200, data: { draft: { text: 'stale' } } });
    await refresh;
    expect(useStore.getState().liveDraft).toBeNull();
  });

  it('starts a fresh contextual refresh after switching away and back to the same session', async () => {
    const first = { ...session('context-a'), mode: 'contextual_local' as const };
    const second = session('legacy-b');
    const liveResolvers: Array<(value: JsonResponse<unknown>) => void> = [];
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/context-a/asr/live') {
        return new Promise((resolve) => { liveResolvers.push(resolve); });
      }
      if (req.method === 'GET' && req.path === '/sessions/context-a/asr/live/scheduler') {
        return {
          ok: true,
          status: 200,
          data: {
            capable: true, accepted_count: 0, status: 'idle', captured_target_sequence: null,
            processed_window: null, stable_frontier_ms: 0, lag_ms: null, block_reason: null,
          },
        };
      }
      if (req.method === 'GET' && req.path === '/sessions/context-a') {
        return { ok: true, status: 200, data: { session: first, segments: [], messages: [], notes: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/legacy-b') {
        return { ok: true, status: 200, data: { session: second, segments: [], messages: [], notes: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/legacy-b/audio') {
        return { ok: true, status: 200, data: { chunks: [], next_after_sequence: null } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({ sessions: [first, second] });

    await useStore.getState().selectSession(first.id);
    await vi.waitFor(() => expect(liveResolvers).toHaveLength(1));
    await useStore.getState().selectSession(second.id);
    await useStore.getState().selectSession(first.id);
    await vi.waitFor(() => expect(liveResolvers).toHaveLength(2));

    liveResolvers[1]!({ ok: true, status: 200, data: { draft: { text: 'fresh generation' } } });
    await vi.waitFor(() => expect(useStore.getState().liveDraft?.text).toBe('fresh generation'));
    liveResolvers[0]!({ ok: true, status: 200, data: { draft: { text: 'stale generation' } } });
    await vi.waitFor(() => expect(useStore.getState().activeSessionId).toBe(first.id));
    expect(useStore.getState().liveDraft?.text).toBe('fresh generation');
  });

  it('never automatically retranscribes pending or failed archived audio on session restore', async () => {
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/restored') {
        return { ok: true, status: 200, data: { session: session('restored'), segments: [], messages: [], notes: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/restored/audio') {
        return {
          ok: true,
          status: 200,
          data: {
            chunks: [
              { sequence: 10, start_ms: 0, end_ms: 10, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' },
              { sequence: 11, start_ms: 10, end_ms: 20, status: 'failed', available: true, segment_ids: [], source_kind: 'original_captured_wav' },
            ],
            next_after_sequence: null,
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    await useStore.getState().selectSession('restored');
    expect(window.audiohelper.fetchAudio).not.toHaveBeenCalled();
    expect(window.audiohelper.uploadAudio).not.toHaveBeenCalled();
    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
    expect(useStore.getState().detail?.segments).toEqual([]);
  });

  it('never appends an ask response after the user switches sessions', async () => {
    let resolveAsk!: (value: JsonResponse<unknown>) => void;
    bridge.request = vi.fn((req: BridgeRequest) => {
      if (req.path.endsWith('/ask')) return new Promise((resolve) => { resolveAsk = resolve; });
      throw new Error(`unexpected ${req.path}`);
    });
    useStore.setState({ activeSessionId: 'a', detail: { segments: [], messages: [], notes: null } });
    const request = useStore.getState().ask('What happened?');
    useStore.setState({ activeSessionId: 'b', detail: { segments: [], messages: [], notes: null } });
    resolveAsk({
      ok: true,
      status: 200,
      data: { answer: 'for a', citations: [], context: { start_ms: 0, end_ms: 1, scope: 'auto' }, model: 'm' },
    });
    await request;
    expect(useStore.getState().detail?.messages).toEqual([]);
  });

  it('resets the chat scope to auto when switching to a different session', async () => {
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/scope-a') {
        return { ok: true, status: 200, data: { session: session('scope-a'), segments: [], messages: [], notes: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/scope-a/audio') {
        return { ok: true, status: 200, data: { chunks: [], next_after_sequence: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/scope-b') {
        return { ok: true, status: 200, data: { session: session('scope-b'), segments: [], messages: [], notes: null } };
      }
      if (req.method === 'GET' && req.path === '/sessions/scope-b/audio') {
        return { ok: true, status: 200, data: { chunks: [], next_after_sequence: null } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    useStore.setState({ sessions: [session('scope-a'), session('scope-b')] });

    await useStore.getState().selectSession('scope-a');
    useStore.setState({ chatScope: 'search', windowMinutes: 10 });

    // Reselecting the same session must not disturb a scope the user just set.
    await useStore.getState().selectSession('scope-a');
    expect(useStore.getState().chatScope).toBe('search');

    // Switching to a different session resets to auto.
    await useStore.getState().selectSession('scope-b');
    expect(useStore.getState().chatScope).toBe('auto');
  });

  it('never installs generated notes into another selected session', async () => {
    let resolveNotes!: (value: JsonResponse<Note>) => void;
    bridge.request = vi.fn((req: BridgeRequest) => {
      if (req.path.endsWith('/notes')) return new Promise((resolve) => { resolveNotes = resolve; });
      throw new Error(`unexpected ${req.path}`);
    });
    useStore.setState({ activeSessionId: 'a', detail: { segments: [], messages: [], notes: null } });
    const request = useStore.getState().generateNotes();
    useStore.setState({ activeSessionId: 'b', detail: { segments: [], messages: [], notes: null } });
    resolveNotes({
      ok: true,
      status: 200,
      data: { content: 'for a', created_at: '2026-09-06T00:00:00Z', model: 'm', citations: [] },
    });
    await request;
    expect(useStore.getState().detail?.notes).toBeNull();
  });
});
