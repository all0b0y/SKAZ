import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../../api/bridge';
import { useStore } from '../../state/store';
import { TranscriptView } from './TranscriptView';
import { encodeWavPcm16Mono } from '../../audio/wav';

const syntheticPcmWav = () => encodeWavPcm16Mono(new Float32Array([0, 0.25, -0.25, 0]), 8_000);

/**
 * Diagnostics are collapsed by default now (an investigation tool, not daily
 * reading). Tests that assert on the player's contents open it first.
 */
const openDiagnostics = async () => {
  const toggle = screen.queryByRole('button', { name: /diagnostic audio/i });
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') {
    await userEvent.click(toggle);
  }
};

const bridge = window.audiohelper as unknown as Omit<BridgeApi, 'request' | 'fetchAudio' | 'uploadAudio'> & {
  request: ReturnType<typeof vi.fn>;
  fetchAudio: ReturnType<typeof vi.fn>;
  uploadAudio: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:transcript'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  Element.prototype.scrollIntoView = vi.fn();
  bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    if (req.method === 'GET' && req.path === '/sessions/session-a/audio') {
      return {
        ok: true,
        status: 200,
        data: {
          chunks: [{
            sequence: 41, start_ms: 0, end_ms: 1_000, status: 'done', available: true,
            segment_ids: ['segment-real'], source_kind: 'original_captured_wav',
          }],
          next_after_sequence: null,
        },
      };
    }
    if (req.method === 'GET' && req.path === '/sessions/session-a/asr/live') {
      return {
        ok: true,
        status: 200,
        data: {
          draft: useStore.getState().liveDraft,
          source_integrity: useStore.getState().liveSourceIntegrity,
          resume_compatibility: useStore.getState().liveResumeCompatibility,
        },
      };
    }
    if (req.method === 'GET' && req.path === '/sessions/session-a/asr/live/scheduler') {
      return { ok: true, status: 200, data: useStore.getState().liveScheduler };
    }
    if (req.method === 'GET' && req.path === '/sessions/session-a/asr/fragments') {
      const state = useStore.getState() as unknown as { liveFragments?: unknown[] };
      return { ok: true, status: 200, data: { fragments: state.liveFragments ?? [] } };
    }
    if (req.method === 'GET' && req.path === '/sessions/session-a') {
      return {
        ok: true,
        status: 200,
        data: {
          session: useStore.getState().sessions[0],
          segments: useStore.getState().detail?.segments ?? [], messages: [], notes: null,
        },
      };
    }
    throw new Error(`unexpected request ${req.method} ${req.path}`);
  });
  bridge.fetchAudio = vi.fn(async () => ({ ok: true, status: 200, data: syntheticPcmWav() }));
  bridge.uploadAudio = vi.fn();
  useStore.setState({
    activeSessionId: 'session-a',
    sessions: [{ id: 'session-a', title: 'A', created_at: 'now', status: 'stopped', duration_ms: 1_000, mode: 'legacy' }],
    detail: { segments: [], messages: [], notes: null },
    detailLoading: false,
    detailError: null,
    recorderState: 'stopped',
    queue: {
      pending: 0, inFlight: null, completed: 0, duplicates: 0, failed: [],
      droppedCount: 0, overflow: false, lastError: null,
    },
    liveCapabilities: null,
    liveDraft: null,
    liveFragments: [],
    liveSourceIntegrity: null,
    liveResumeCompatibility: null,
    liveScheduler: null,
    liveError: null,
  });
});

describe('TranscriptView diagnostic audio seam', () => {
  it('renders final prefix and unstable draft as one flow, but isolates whole-window conflict', async () => {
    useStore.setState({
      sessions: [{ id: 'session-a', title: 'A', created_at: 'now', status: 'stopped', duration_ms: 1_000, mode: 'contextual_local' }],
      detail: {
        segments: [{ id: 'segment-real', start_ms: 0, end_ms: 400, text: 'Final prefix' }],
        messages: [], notes: null,
      },
      liveDraft: {
        state: 'draft', revision: 2, epoch: 1, updated_at: 'now', text: 'draft tail',
        text_scope: 'unstable_tail', language: 'en', provider: 'local-whisper', model: 'small',
        requested_language: 'auto', speech_gate_enabled: true, source_fingerprint: 's',
        config_fingerprint: 'c', config_revision: 1,
        window: { start_ms: 0, end_ms: 1_000, sample_rate: 16_000, sample_count: 16_000, model_input_sample_rate: 16_000, model_input_sample_count: 16_000, model_input_kind: 'assembled_pcm16_mono_resampled_for_local_whisper' },
        sources: [{ sequence: 41, start_ms: 0, end_ms: 1_000, sample_rate: 16_000, sample_count: 16_000, window_sample_start: 0, window_sample_end: 16_000, sha256: 'x', source_kind: 'original_captured_wav' }],
      },
      liveScheduler: { capable: true, accepted_count: 1, status: 'complete', captured_target_sequence: 41, processed_window: { first_sequence: 41, last_sequence: 41, start_ms: 0, end_ms: 1_000 }, stable_frontier_ms: 700, lag_ms: 300, block_reason: null },
    });
    const view = render(<TranscriptView focusSegmentId={null} />);
    expect(await screen.findByText('Final prefix')).toBeInTheDocument();
    expect(screen.getByText('draft tail')).toHaveClass('transcript__draft-text');
    expect(screen.getByRole('list', { name: /contextual flowing transcript/i })).toHaveTextContent(/Final prefix.*draft tail/);
    expect(screen.getByText(/Available audio processed; draft remains/i)).toBeInTheDocument();

    act(() => useStore.setState({ liveDraft: { ...useStore.getState().liveDraft!, text: 'conflicting whole window', text_scope: 'whole_window' } }));
    expect(screen.getByText('conflicting whole window')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/conflict/i);
    view.unmount();
  });

  it('keeps the diagnostic player visible for an audio-only session', async () => {
    render(<TranscriptView focusSegmentId={null} />);
    await openDiagnostics();
    expect(await screen.findByRole('region', { name: /diagnostic audio/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'SKAZ AGENT' })).toBeInTheDocument();
    expect(screen.getByText(/Chunk 41/)).toBeInTheDocument();
  });

  it('does not render an empty transcript card when a blank segment reaches the UI', async () => {
    useStore.setState({
      detail: {
        segments: [{ id: 'blank-segment', start_ms: 0, end_ms: 400, text: '   ' }],
        messages: [], notes: null,
      },
    });

    const view = render(<TranscriptView focusSegmentId={null} />);
    await openDiagnostics();
    await screen.findByRole('region', { name: /diagnostic audio/i });

    expect(view.container.querySelectorAll('.segment')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'SKAZ AGENT' })).toBeInTheDocument();
  });

  it('shows the "Listening…" empty state instead of the logo while actively recording', async () => {
    useStore.setState({ recorderState: 'recording' });
    render(<TranscriptView focusSegmentId={null} />);
    expect(await screen.findByText('Listening…', { selector: '.empty__title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'SKAZ AGENT' })).not.toBeInTheDocument();
  });

  it('retains historical draft text but disables source playback when integrity is untrusted', async () => {
    useStore.setState({
      sessions: [{ id: 'session-a', title: 'A', created_at: 'now', status: 'stopped', duration_ms: 1_000, mode: 'contextual_local' }],
      liveDraft: {
        state: 'draft', revision: 2, epoch: 1, updated_at: 'now', text: 'historical text',
        text_scope: 'unstable_tail', language: 'en', provider: 'local-whisper', model: 'small',
        requested_language: 'auto', speech_gate_enabled: true, source_fingerprint: 's',
        config_fingerprint: 'c', config_revision: 1,
        window: { start_ms: 0, end_ms: 1_000, sample_rate: 16_000, sample_count: 16_000, model_input_sample_rate: 16_000, model_input_sample_count: 16_000, model_input_kind: 'assembled_pcm16_mono_resampled_for_local_whisper' },
        sources: [{ sequence: 41, start_ms: 0, end_ms: 1_000, sample_rate: 16_000, sample_count: 16_000, window_sample_start: 0, window_sample_end: 16_000, sha256: 'x', source_kind: 'original_captured_wav' }],
      },
      liveSourceIntegrity: {
        status: 'missing', trusted: false, detail: 'Saved draft source audio is missing.',
      },
      liveResumeCompatibility: {
        status: 'source_unavailable', can_resume: false, requires_redecode: false,
        detail: 'Trusted source audio is required before this historical draft can resume.',
      },
    });

    render(<TranscriptView focusSegmentId={null} />);

    expect(await screen.findByText('historical text')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/source audio is not trusted/i);
    expect(screen.getByRole('button', { name: /Draft sources/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Resume contextual processing/i })).toBeDisabled();
  });

  it('labels bounded source continuity as unverified without claiming a known gap', async () => {
    useStore.setState({
      sessions: [{ id: 'session-a', title: 'A', created_at: 'now', status: 'stopped', duration_ms: 1_000, mode: 'contextual_local' }],
      liveScheduler: {
        capable: false,
        accepted_count: 0,
        status: 'stalled',
        captured_target_sequence: 70,
        processed_window: { first_sequence: 0, last_sequence: 63, start_ms: 0, end_ms: 640 },
        stable_frontier_ms: 0,
        lag_ms: 710,
        block_reason: 'decoder_failed',
        recovery_required: true,
        available_audio_processed: false,
        source_continuity_verified: false,
      },
    });

    render(<TranscriptView focusSegmentId={null} />);

    expect(await screen.findByText(/continuity beyond the bounded preview is unverified/i))
      .toBeInTheDocument();
    expect(screen.queryByText(/source gap detected/i)).not.toBeInTheDocument();
  });

  it('offers explicit contextual recovery during capture but hides it once processing is healthy', async () => {
    const user = userEvent.setup();
    useStore.setState({
      sessions: [{ id: 'session-a', title: 'A', created_at: 'now', status: 'recording', duration_ms: 1_000, mode: 'contextual_local' }],
      recorderState: 'recording',
      queue: { ...useStore.getState().queue, pending: 2 },
      liveCapabilities: {
        mode: 'contextual_local', capable: true,
        requirements: { local_profile_selected: true, contextual_local_enabled: true, live_finality_enabled: true, local_speech_gate_enabled: true },
        detail: 'available',
      },
      liveResumeCompatibility: {
        status: 'compatible', can_resume: true, requires_redecode: false,
      },
      liveScheduler: {
        capable: true, accepted_count: 1, status: 'stalled', captured_target_sequence: 41,
        processed_window: { first_sequence: 41, last_sequence: 41, start_ms: 0, end_ms: 1_000 },
        stable_frontier_ms: 500, lag_ms: 500, block_reason: 'decoder_failed',
        recovery_required: true, available_audio_processed: false,
      },
    });
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'GET' && req.path === '/sessions/session-a/audio') {
        return {
          ok: true, status: 200,
          data: {
            chunks: [{
              sequence: 41, start_ms: 0, end_ms: 1_000, status: 'done', available: true,
              segment_ids: [], source_kind: 'original_captured_wav',
            }],
            next_after_sequence: null,
          },
        };
      }
      if (req.method === 'GET' && req.path === '/sessions/session-a/asr/live') {
        return {
          ok: true, status: 200,
          data: {
            draft: null,
            resume_compatibility: useStore.getState().liveResumeCompatibility,
          },
        };
      }
      if (req.method === 'GET' && req.path === '/sessions/session-a/asr/live/scheduler') {
        return { ok: true, status: 200, data: useStore.getState().liveScheduler };
      }
      if (req.method === 'GET' && req.path === '/sessions/session-a') {
        return {
          ok: true, status: 200,
          data: {
            session: useStore.getState().sessions[0],
            segments: [], messages: [], notes: null,
          },
        };
      }
      if (req.method === 'POST' && req.path === '/sessions/session-a/asr/live/advance') {
        return {
          ok: true, status: 202,
          data: {
            accepted: true,
            scheduler: {
              capable: true, accepted_count: 2, status: 'running', captured_target_sequence: 41,
              processed_window: { first_sequence: 41, last_sequence: 41, start_ms: 0, end_ms: 1_000 },
              stable_frontier_ms: 500, lag_ms: 500, block_reason: null,
              recovery_required: false, available_audio_processed: false,
            },
          },
        };
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });

    render(<TranscriptView focusSegmentId={null} />);

    const resume = await screen.findByRole('button', { name: /resume contextual processing/i });
    expect(resume).toBeEnabled();
    await user.click(resume);
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledWith({
      method: 'POST', path: '/sessions/session-a/asr/live/advance', body: { through_sequence: 41 },
    }));
    expect(useStore.getState().recorderState).toBe('recording');
    expect(useStore.getState().queue.pending).toBe(2);
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: /resume contextual processing/i })).not.toBeInTheDocument());
  });

  it('persists an absolute-range fragment edit and keeps dirty text across polling', async () => {
    const user = userEvent.setup();
    const openFragment = {
      fragment_id: 'fragment-open', ordinal: 0, start_ms: 120, observed_end_ms: 800,
      protected_through_ms: 800, text: 'editable draft', language: 'en', state: 'open',
      state_reason: null, revision: 2, draft_revision: 2, config_revision: 1,
      range_fingerprint: 'range-sha', protected: false, completion_provenance: null,
      segment_id: null, accepted_at: null, source_integrity: 'verified', sources: [],
      can_edit: true, edit_disabled_reason: null, can_accept: false,
      accept_disabled_reason: 'Fragment processing is not complete.',
    };
    useStore.setState({
      sessions: [{ id: 'session-a', title: 'A', created_at: 'now', status: 'stopped', duration_ms: 1_000, mode: 'contextual_local' }],
      liveDraft: {
        state: 'draft', revision: 2, epoch: 1, updated_at: 'now', text: 'editable draft',
        text_scope: 'unstable_tail', language: 'en', provider: 'local-whisper', model: 'small',
        requested_language: 'auto', speech_gate_enabled: true, source_fingerprint: 's',
        config_fingerprint: 'c', config_revision: 1,
        window: { start_ms: 0, end_ms: 1_000, sample_rate: 16_000, sample_count: 16_000, model_input_sample_rate: 16_000, model_input_sample_count: 16_000, model_input_kind: 'assembled_pcm16_mono_resampled_for_local_whisper' },
        sources: [],
        finality: { enabled: true, status: 'awaiting_agreement', blocked_reason: null, stable_frontier_ms: 0 },
      },
      liveFragments: [openFragment],
    } as unknown as Parameters<typeof useStore.setState>[0]);
    let resolveEdit: ((value: JsonResponse<unknown>) => void) | null = null;
    const original = bridge.request.getMockImplementation();
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'PUT' && req.path.endsWith('/fragments/fragment-open/text')) {
        return await new Promise((resolve) => { resolveEdit = resolve; });
      }
      return await original!(req);
    });

    render(<TranscriptView focusSegmentId={null} />);

    await user.click(await screen.findByRole('button', { name: /edit draft/i }));
    const editor = screen.getByRole('textbox', { name: /edit fragment/i });
    await user.clear(editor);
    await user.type(editor, 'human expanded correction');
    expect(screen.getByText(/00:00.120–00:00.800/)).toBeInTheDocument();
    await act(async () => { await useStore.getState().refreshContextualLive('session-a'); });
    expect(editor).toHaveValue('human expanded correction');
    await user.click(screen.getByRole('button', { name: /save edit/i }));
    expect(screen.getByRole('button', { name: /saving edit/i })).toBeDisabled();
    await act(async () => {
      resolveEdit!({ ok: true, status: 200, data: {
        ...openFragment, text: 'human expanded correction', revision: 3, protected: true,
      } });
    });
    expect(await screen.findByText('human expanded correction')).toBeInTheDocument();
    expect(bridge.request).toHaveBeenCalledWith({
      method: 'PUT', path: '/sessions/session-a/asr/fragments/fragment-open/text',
      body: { text: 'human expanded correction', expected_revision: 2, range_fingerprint: 'range-sha' },
    });
  });

  it('keeps accept disabled with a reason when fragment finalization is stalled', async () => {
    useStore.setState({
      sessions: [{ id: 'session-a', title: 'A', created_at: 'now', status: 'stopped', duration_ms: 1_000, mode: 'contextual_local' }],
      liveDraft: {
        state: 'draft', revision: 2, epoch: 1, updated_at: 'now', text: 'blocked draft',
        text_scope: 'unstable_tail', language: 'en', provider: 'local-whisper', model: 'small',
        requested_language: 'auto', speech_gate_enabled: true, source_fingerprint: 's',
        config_fingerprint: 'c', config_revision: 1,
        window: { start_ms: 0, end_ms: 1_000, sample_rate: 16_000, sample_count: 16_000, model_input_sample_rate: 16_000, model_input_sample_count: 16_000, model_input_kind: 'assembled_pcm16_mono_resampled_for_local_whisper' },
        sources: [],
        finality: { enabled: true, status: 'blocked', blocked_reason: 'stable_prefix_mismatch', stable_frontier_ms: 0 },
      },
      liveScheduler: {
        capable: true, accepted_count: 1, status: 'stalled', captured_target_sequence: 41,
        processed_window: { first_sequence: 41, last_sequence: 41, start_ms: 0, end_ms: 1_000 },
        stable_frontier_ms: 0, lag_ms: 1_000, block_reason: 'finality_blocked',
      },
      liveFragments: [{
        fragment_id: 'fragment-error', ordinal: 0, start_ms: 100, observed_end_ms: 800,
        protected_through_ms: 800, text: 'blocked draft', language: 'en', state: 'error',
        state_reason: 'stable_prefix_mismatch', revision: 2, draft_revision: 2,
        config_revision: 1, range_fingerprint: 'range-error', protected: true,
        completion_provenance: null, segment_id: null, accepted_at: null,
        source_integrity: 'verified', sources: [], can_edit: true,
        edit_disabled_reason: null, can_accept: false,
        accept_disabled_reason: 'stable_prefix_mismatch',
      }],
    } as unknown as Parameters<typeof useStore.setState>[0]);

    render(<TranscriptView focusSegmentId={null} />);

    const accept = await screen.findByRole('button', { name: /accept draft/i });
    expect(accept).toBeDisabled();
    expect(screen.getByText(/stable prefix mismatch/i)).toBeInTheDocument();
  });

  it('accepts only a completed fragment and installs persisted acknowledgement', async () => {
    const user = userEvent.setup();
    const completed = {
      fragment_id: 'fragment-complete', ordinal: 0, start_ms: 100, observed_end_ms: 700,
      protected_through_ms: 700, text: 'completed text', language: 'en', state: 'complete',
      state_reason: null, revision: 4, draft_revision: 3, config_revision: 1,
      range_fingerprint: 'range-complete', protected: true,
      completion_provenance: 'live_agreement', segment_id: 'segment-real', accepted_at: null,
      source_integrity: 'verified', sources: [], can_edit: false,
      edit_disabled_reason: 'Completed immutable fragments cannot be edited in this slice.',
      can_accept: true, accept_disabled_reason: null,
    };
    useStore.setState({
      sessions: [{ id: 'session-a', title: 'A', created_at: 'now', status: 'stopped', duration_ms: 1_000, mode: 'contextual_local' }],
      liveFragments: [completed],
    } as unknown as Parameters<typeof useStore.setState>[0]);
    const original = bridge.request.getMockImplementation();
    bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.method === 'POST' && req.path.endsWith('/fragments/fragment-complete/accept')) {
        return { ok: true, status: 200, data: {
          ...completed, revision: 5, accepted_at: '2026-09-11T12:00:00Z',
          can_accept: false, accept_disabled_reason: 'Fragment has already been accepted.',
        } };
      }
      return await original!(req);
    });
    render(<TranscriptView focusSegmentId={null} />);

    const accept = await screen.findByRole('button', { name: /accept fragment/i });
    expect(accept).toBeEnabled();
    await user.click(accept);
    expect(await screen.findByText(/accepted/i)).toBeInTheDocument();
    expect(bridge.request).toHaveBeenCalledWith({
      method: 'POST', path: '/sessions/session-a/asr/fragments/fragment-complete/accept',
      body: {
        expected_revision: 4, range_fingerprint: 'range-complete',
        idempotency_key: expect.stringMatching(/^accept-fragment-complete-/),
      },
    });
  });

  it('highlights the segment whose range contains the live playback position, and moves the highlight as time advances', async () => {
    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
    vi.spyOn(audio, 'play').mockResolvedValue();
    vi.spyOn(audio, 'pause').mockImplementation(() => undefined);
    vi.stubGlobal('Audio', vi.fn(() => audio));
    useStore.setState({
      detail: {
        segments: [
          { id: 'seg-a', start_ms: 0, end_ms: 500, text: 'first half' },
          { id: 'seg-b', start_ms: 500, end_ms: 1_000, text: 'second half' },
        ],
        messages: [], notes: null,
      },
    });

    render(<TranscriptView focusSegmentId={null} />);
    await screen.findByText(/Chunk 41/);
    await openDiagnostics();
    await act(async () => { screen.getByRole('button', { name: /play full recording/i }).click(); });

    const rows = () => Array.from(document.querySelectorAll('.segment'));
    expect(rows()[0]).toHaveClass('segment--playing');
    expect(rows()[1]).not.toHaveClass('segment--playing');

    await act(async () => {
      audio.currentTime = 0.7;
      audio.dispatchEvent(new Event('timeupdate'));
    });

    expect(rows()[0]).not.toHaveClass('segment--playing');
    expect(rows()[1]).toHaveClass('segment--playing');
  });

  it('does not highlight any segment once playback pauses', async () => {
    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
    vi.spyOn(audio, 'play').mockResolvedValue();
    vi.spyOn(audio, 'pause').mockImplementation(() => undefined);
    vi.stubGlobal('Audio', vi.fn(() => audio));
    useStore.setState({
      detail: {
        segments: [{ id: 'seg-a', start_ms: 0, end_ms: 500, text: 'first half' }],
        messages: [], notes: null,
      },
    });

    render(<TranscriptView focusSegmentId={null} />);
    await screen.findByText(/Chunk 41/);
    await openDiagnostics();
    await act(async () => { screen.getByRole('button', { name: /play full recording/i }).click(); });
    expect(document.querySelector('.segment')).toHaveClass('segment--playing');

    await act(async () => { screen.getByRole('button', { name: /pause/i }).click(); });
    expect(document.querySelector('.segment')).not.toHaveClass('segment--playing');
  });

  it('citation focus never starts playback; an explicit timestamp click uses the real linked chunk', async () => {
    const user = userEvent.setup();
    useStore.setState({
      detail: {
        segments: [{ id: 'segment-real', start_ms: 300, end_ms: 800, text: 'synthetic text' }],
        messages: [], notes: null,
      },
    });
    const view = render(<TranscriptView focusSegmentId={null} />);
    await screen.findByText(/Chunk 41/);
    view.rerender(<TranscriptView focusSegmentId="segment-real" />);
    expect(bridge.fetchAudio).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Play source chunk/i }));
    expect(bridge.fetchAudio).toHaveBeenCalledWith('session-a', 41);
    expect(bridge.uploadAudio).not.toHaveBeenCalled();
    expect(bridge.request.mock.calls.filter(([request]) => request.path === '/sessions/session-a/audio')).toHaveLength(1);
    expect(bridge.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('keeps audio available when transcript loading fails', async () => {
    act(() => useStore.setState({ detailError: 'ASR transcript unavailable' }));
    render(<TranscriptView focusSegmentId={null} />);
    expect(await screen.findByText(/Chunk 41/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn’t load the transcript/i)).toBeInTheDocument();
  });

  it('renders a permanent language-switch marker at the right point in the timeline and it survives further updates', async () => {
    useStore.setState({
      detail: {
        segments: [
          { id: 'seg-1', start_ms: 0, end_ms: 400, text: 'Before the switch' },
          { id: 'seg-2', start_ms: 60_000, end_ms: 60_400, text: 'After the switch' },
        ],
        messages: [], notes: null,
      },
      languageMarks: [{ atMs: 41_000, language: 'en' }],
    });

    render(<TranscriptView focusSegmentId={null} />);
    await openDiagnostics();
    await screen.findByRole('region', { name: /diagnostic audio/i });

    expect(screen.getByText(/── EN from 00:41 ──/)).toBeInTheDocument();

    const container = document.querySelector('.transcript__list');
    expect(container).toBeTruthy();
    const rowTexts = Array.from(container!.children).map((el) => el.textContent);
    // The marker sits between the segment before it and the one after it.
    const markIndex = rowTexts.findIndex((text) => text?.includes('EN from 00:41'));
    const beforeIndex = rowTexts.findIndex((text) => text?.includes('Before the switch'));
    const afterIndex = rowTexts.findIndex((text) => text?.includes('After the switch'));
    expect(beforeIndex).toBeLessThan(markIndex);
    expect(markIndex).toBeLessThan(afterIndex);

    // A later, unrelated store update must not make the marker disappear —
    // it is a permanent part of this session's history, not a toast.
    act(() => useStore.setState({ detailError: null }));
    expect(screen.getByText(/── EN from 00:41 ──/)).toBeInTheDocument();
  });
});
