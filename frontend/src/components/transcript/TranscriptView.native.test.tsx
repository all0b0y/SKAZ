import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../../api/bridge';

let TranscriptView: (typeof import('./TranscriptView'))['TranscriptView'];
let useStore: (typeof import('../../state/store'))['useStore'];
let phase: string;
let finalText: string;
let draftText: string;
let calls: BridgeRequest[];
beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  phase = 'streaming'; finalText = 'Confirmed text'; draftText = 'Unconfirmed tail'; calls = [];
  const request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
    calls.push(req);
    let data: unknown;
    if (req.path === '/sessions/native/live') data = {
      session_id: 'native', sample_rate: 16000, saved_samples: 48000, next_sequence: 30,
      transcription: phase,
      connections: [{ id: 'c1', start_sample: 16000, end_sample: null, final_sample: 32000,
        processed_sample: 40000, status: 'active', draft_json: JSON.stringify([
          { text: draftText, start_ms: 1000, end_ms: 1500 },
        ]) }],
      gaps: [{ start_sample: 0, end_sample: 16000 }],
    };
    else if (req.path === '/sessions/native') data = {
      session: { id: 'native', title: 'Native', mode: 'legacy', status: 'recording', duration_ms: 3000, created_at: '' },
      segments: [{ id: 'final-1', start_ms: 1000, end_ms: 2000, text: finalText }], messages: [], notes: null,
    };
    else return { ok: false, status: 404, detail: 'Not found' };
    return { ok: true, status: 200, data: data as T };
  };
  window.audiohelper = { ...window.audiohelper, request } satisfies BridgeApi;
  useStore = (await import('../../state/store')).useStore;
  useStore.setState({ activeSessionId: 'native', recorderState: 'recording',
    detail: { segments: [], messages: [], notes: null }, detailLoading: false, detailError: null });
  TranscriptView = (await import('./TranscriptView')).TranscriptView;
});
afterEach(() => { vi.useRealTimers(); });

describe('native transcript read model', () => {
  it('keeps mixed translated turns ordered and ambiguous text separate, using the recording mode', async () => {
    const original = window.audiohelper.request;
    window.audiohelper.request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      const response = await original<T>(req);
      if (req.path !== '/sessions/native/live' || !response.ok) return response;
      const originals = ['Hello', ' ja', 'Thanks', 'Yes', 'Again'].map((text, i) => ({
        id: `o${i}`, text, connection_id: 'c1', speaker_number: i === 3 ? 2 : 1,
        segment_id: 'final-1', start_sample: i * 100, end_sample: (i + 1) * 100,
      }));
      const translations = ['Hallo', ' danke', 'Ja', 'Nochmals', 'Uncertain'].map((text, i) => ({
        id: `t${i}`, text, connection_id: 'c1', speaker_number: i === 2 ? 2 : 1,
      }));
      return { ...response, data: { ...response.data, recording_mode: 'translation', final_tokens: originals,
        live_translation_projection: { original_tokens: originals, translation_tokens: translations,
          monologues: [
            { id: 'a', connection_id: 'c1', speaker_number: 1, original_token_ids: ['o0', 'o1', 'o2'],
              display_token_ids: ['t0', 'o1', 't1'] },
            { id: 'b', connection_id: 'c1', speaker_number: 2, original_token_ids: ['o3'], display_token_ids: ['t2'] },
            { id: 'c', connection_id: 'c1', speaker_number: 1, original_token_ids: ['o4'], display_token_ids: ['t3'] },
          ], unassigned_translation_token_ids: ['t4'], order_unavailable_connection_ids: [],
        },
      } as T };
    };
    render(<TranscriptView focusSegmentId={null} />);
    const list = await screen.findByRole('list', { name: 'Транскрипция' });
    const turns = within(list).getAllByRole('listitem');
    expect(turns).toHaveLength(4);
    expect(turns[0]?.querySelector('p')).toHaveTextContent('Hallo ja danke');
    expect(turns[1]?.querySelector('p')).toHaveTextContent('Ja');
    expect(turns[2]?.querySelector('p')).toHaveTextContent('Nochmals');
    expect(turns[3]).toHaveTextContent('Перевод без точной привязки к репликеUncertain');
    expect(within(list).getByText('Hello')).not.toBeVisible();
    expect(within(list).getAllByText('Uncertain')).toHaveLength(1);
  });

  it('preserves historical translation without exposing originals as the main text', async () => {
    const original = window.audiohelper.request;
    window.audiohelper.request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      const response = await original<T>(req);
      if (req.path !== '/sessions/native/live' || !response.ok) return response;
      return { ...response, data: { ...response.data, recording_mode: 'translation',
        final_translation_tokens: [{ id: 'old', connection_id: 'c1', speaker_number: null, text: 'Исторический перевод' }],
      } as T };
    };
    render(<TranscriptView focusSegmentId={null} />);
    const list = await screen.findByRole('list', { name: 'Транскрипция' });
    expect(within(list).getByText('Исторический перевод')).toBeVisible();
    expect(within(list).getByText('Confirmed text')).not.toBeVisible();
    expect(within(list).getByText('Unconfirmed tail')).not.toBeVisible();
  });

  it('shows live translation as primary text, reveals original and follows source citations', async () => {
    vi.useFakeTimers();
    let translated = 'Привет';
    const original = window.audiohelper.request;
    window.audiohelper.request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      const response = await original<T>(req);
      if (req.path !== '/sessions/native/live' || !response.ok) return response;
      const source = { id: 't1', connection_id: 'c1', segment_id: 'final-1', text: 'Hello',
        speaker_number: 1, start_sample: 16000, end_sample: 32000 };
      return { ...response, data: { ...response.data, recording_mode: 'translation', final_tokens: [source],
        live_translation_projection: {
          original_tokens: [source],
          translation_tokens: translated ? [{ id: 'tr1', connection_id: 'c1', speaker_number: 1, text: translated }] : [],
          monologues: [{ id: 't1', connection_id: 'c1', speaker_number: 1, original_token_ids: ['t1'],
            translation_token_ids: translated ? ['tr1'] : [], passthrough_token_ids: [], display_token_ids: translated ? ['tr1'] : [] }],
          unassigned_translation_token_ids: [], order_unavailable_connection_ids: [],
        },
      } as T };
    };
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const view = render(<TranscriptView focusSegmentId={null} />);
    await act(async () => {});
    const list = screen.getByRole('list', { name: 'Транскрипция' });
    expect(within(list).getByText('Привет')).toBeVisible();
    expect(within(list).getByText('Hello')).not.toBeVisible();
    fireEvent.click(within(list).getByText('Показать оригинал'));
    expect(within(list).getByText('Hello')).toBeVisible();
    fireEvent.click(within(list).getByText('Показать оригинал'));
    translated = 'Здравствуйте';
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(list).queryByText('Привет')).not.toBeInTheDocument();
    expect(within(list).getByText('Здравствуйте')).toBeVisible();
    expect(within(list).getByText('Hello')).not.toBeVisible();
    translated = '';
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(list).getByText('Hello')).not.toBeVisible();
    view.rerender(<TranscriptView focusSegmentId="final-1" />);
    expect(within(list).getByText('Hello')).toBeVisible();
    expect(scroll).toHaveBeenCalled();
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('renders speaker turns rather than timed chunks, with a replaceable inline tail', async () => {
    vi.useFakeTimers();
    let tailSpeaker = '1';
    const original = window.audiohelper.request;
    window.audiohelper.request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      const response = await original<T>(req);
      if (req.path !== '/sessions/native/live' || !response.ok) return response;
      return { ...response, data: {
        ...response.data,
        speakers: [{ connection_id: 'c1', provider_id: '1', number: 1 }, { connection_id: 'c1', provider_id: '2', number: 2 }],
        final_tokens: [
          { id: 't1', connection_id: 'c1', segment_id: 'final-1', text: 'Hello', speaker_number: 1, start_sample: 16000, end_sample: 20000 },
          { id: 't2', connection_id: 'c1', segment_id: 'final-1', text: ' again.', speaker_number: 1, start_sample: 20000, end_sample: 22000 },
          { id: 't3', connection_id: 'c1', segment_id: 'final-1', text: 'Yes.', speaker_number: 2, start_sample: 22000, end_sample: 26000 },
          { id: 't4', connection_id: 'c1', segment_id: 'final-1', text: 'And', speaker_number: 1, start_sample: 26000, end_sample: 32000 },
        ],
        connections: [{ id: 'c1', start_sample: 16000, final_sample: 32000, processed_sample: 40000, end_sample: null,
          status: 'active', draft_json: JSON.stringify([{ text: ' now', speaker: tailSpeaker, start_ms: 1000, end_ms: 1500 }]) }],
      } as T };
    };
    render(<TranscriptView focusSegmentId={null} />);
    await act(async () => {});
    const list = screen.getByRole('list', { name: 'Транскрипция' });
    const turns = within(list).getAllByRole('listitem');
    expect(turns).toHaveLength(3);
    expect(turns[0]).toHaveTextContent('Спикер 1Hello again.');
    expect(turns[1]).toHaveTextContent('Спикер 2Yes.');
    expect(turns[2]).toHaveTextContent('Спикер 1And now');
    expect(within(list).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Soniox: transcribing')).not.toBeInTheDocument();
    expect(screen.queryByText('Draft — not used for answers or notes.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Diagnostic audio' })).not.toBeInTheDocument();
    tailSpeaker = '2';
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    tailSpeaker = '1';
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getAllByText('now')).toHaveLength(1);

    const container = list.parentElement!;
    Object.defineProperties(container, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 500 } });
    container.scrollTop = 100;
    fireEvent.scroll(container);
    finalText = 'A different source read';
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(container.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole('button', { name: 'К текущей речи' }));
    expect(container.scrollTop).toBe(2000);
  });

  it('replaces draft and confirmed text on polling without scrolling the reader', async () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const view = render(<TranscriptView focusSegmentId={null} />);
    await act(async () => {});
    expect(screen.getByText('Confirmed text')).toBeInTheDocument();
    phase = 'unavailable'; finalText = 'Next confirmed text'; draftText = 'Replacement draft';
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('Next confirmed text')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed text')).not.toBeInTheDocument();
    expect(screen.queryByText('Unconfirmed tail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Unconfirmed Soniox draft')).toHaveTextContent('Replacement draft');
    expect(screen.getByText(/transcription unavailable — audio is still saved locally/)).toBeInTheDocument();
    expect(scroll).not.toHaveBeenCalled();
    view.unmount();
    const count = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(calls).toHaveLength(count);
  });

  it('does not install a delayed snapshot after switching to an archive', async () => {
    const original = window.audiohelper.request;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    window.audiohelper.request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      if (req.path === '/sessions/archive') return { ok: true, status: 200, data: {
        session: { id: 'archive', title: 'Archive', mode: 'legacy', status: 'stopped', duration_ms: 0, created_at: '' },
        segments: [], messages: [], notes: null,
      } as T };
      const response = await original<T>(req);
      if (req.path === '/sessions/native/live') await gate;
      return response;
    };
    useStore.setState({ recorderState: 'stopped' });
    render(<TranscriptView focusSegmentId={null} />);
    await act(async () => {});
    await act(async () => { await useStore.getState().selectSession('archive'); });
    await act(async () => { release(); });
    expect(screen.queryByText('Confirmed text')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Soniox transcription')).not.toBeInTheDocument();
  });

  it('reads the last final after the inactive barrier instead of keeping an older pre-Stop read', async () => {
    const original = window.audiohelper.request;
    window.audiohelper.request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      if (req.path === '/sessions/native/live') { phase = 'inactive'; finalText = 'Final arriving during Stop'; draftText = ''; }
      return original<T>(req);
    };
    useStore.setState({ recorderState: 'stopped' });
    render(<TranscriptView focusSegmentId={null} />);
    expect(await screen.findByText('Final arriving during Stop')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed text')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Unconfirmed Soniox draft')).not.toBeInTheDocument();
  });

  it('preserves confirmed text and discloses a failed read rather than showing stale streaming as fresh', async () => {
    vi.useFakeTimers();
    const original = window.audiohelper.request;
    const view = render(<TranscriptView focusSegmentId={null} />);
    await act(async () => {});
    expect(screen.getByText('Confirmed text')).toBeInTheDocument();
    window.audiohelper.request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      if (req.path === '/sessions/native/live') return { ok: false, status: 503, detail: 'Unavailable' };
      return original<T>(req);
    };
    // ApiClient captures the bridge object, whose request is replaced at the IPC boundary.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('alert')).toHaveTextContent(/out of date/);
    expect(screen.getByText('Confirmed text')).toBeInTheDocument();
    view.unmount();
  });

  it('shows confirmed text, a separate draft and coverage gaps on the shared audio clock', async () => {
    render(<TranscriptView focusSegmentId={null} />);
    expect(await screen.findByText('Confirmed text')).toBeInTheDocument();
    expect(screen.getByLabelText('Unconfirmed Soniox draft')).toHaveTextContent('Unconfirmed tail');
    expect(screen.getByLabelText('Unconfirmed Soniox draft')).toHaveTextContent('00:02.000');
    expect(screen.getByText(/Soniox: transcribing/)).toBeInTheDocument();
    expect(screen.getByText(/00:00.000–00:01.000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play source chunk at 00:01' })).toBeInTheDocument();
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
