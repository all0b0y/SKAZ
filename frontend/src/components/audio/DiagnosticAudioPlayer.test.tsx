import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticAudioPlayer, type DiagnosticAudioPlayerHandle } from './DiagnosticAudioPlayer';
import type { AudioManifestPage, Segment } from '../../api/types';
import { createRef } from 'react';
import { encodeWavPcm16Mono } from '../../audio/wav';

const syntheticPcmWav = () => encodeWavPcm16Mono(new Float32Array([0, 0.25, -0.25, 0]), 8_000);

const manifest: AudioManifestPage = {
  chunks: [
    { sequence: 4, start_ms: 0, end_ms: 1_000, status: 'done', available: true, segment_ids: ['segment-a'], source_kind: 'original_captured_wav' },
    { sequence: 8, start_ms: 1_500, end_ms: 2_500, status: 'failed', available: false, segment_ids: [], source_kind: 'original_captured_wav' },
  ],
  next_after_sequence: null,
};
const segments: Segment[] = [{ id: 'segment-a', start_ms: 100, end_ms: 800, text: 'hello' }];

describe('DiagnosticAudioPlayer', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an audio-only session and every manifest boundary/status', async () => {
    const api = { getAudioManifestPage: vi.fn(async () => manifest), fetchAudio: vi.fn(async () => syntheticPcmWav()) };
    render(<DiagnosticAudioPlayer sessionId="s1" segments={[]} recording={false} api={api} />);
    expect(await screen.findByRole('region', { name: /diagnostic audio/i })).toBeInTheDocument();
    expect(screen.getByText(/Chunk 4/)).toBeInTheDocument();
    expect(screen.getByText(/Chunk 8/)).toBeInTheDocument();
    expect(screen.getByText(/missing file/i)).toBeInTheDocument();
    // Gaps are summarised in a collapsible row now, so the detail line and the
    // summary both match; assert on the summary count and the precise entry.
    expect(screen.getByText(/1 timeline gap with no captured file/i)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /audio timeline gaps/i })).toBeInTheDocument();
    expect(screen.getByText(/original captured WAV/i)).toBeInTheDocument();
    expect(screen.getByText(/model input.*unknown/i)).toBeInTheDocument();
  });

  it('exposes segment playback by actual id and context as separate actions', async () => {
    const ref = createRef<DiagnosticAudioPlayerHandle>();
    const api = { getAudioManifestPage: vi.fn(async () => manifest), fetchAudio: vi.fn(async () => syntheticPcmWav()) };
    render(<DiagnosticAudioPlayer ref={ref} sessionId="s1" segments={segments} recording={false} api={api} />);
    await screen.findByText(/Chunk 4/);
    await act(async () => { await ref.current?.playSegment('segment-a', false); });
    expect(api.fetchAudio).toHaveBeenCalledWith('s1', 4);
    await act(async () => { await ref.current?.playSegment('not-a-sequence', true); });
    expect(screen.getByRole('alert')).toHaveTextContent(/linked audio chunk/i);
  });

  it('warns about speaker feedback while recording and refreshes only on explicit click', async () => {
    const user = userEvent.setup();
    const api = { getAudioManifestPage: vi.fn(async () => manifest), fetchAudio: vi.fn(async () => syntheticPcmWav()) };
    render(<DiagnosticAudioPlayer sessionId="s1" segments={segments} recording api={api} pollIntervalMs={60_000} />);
    expect(await screen.findByText(/headphones.*feedback/i)).toBeInTheDocument();
    expect(api.getAudioManifestPage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /refresh audio/i }));
    expect(api.getAudioManifestPage).toHaveBeenCalledTimes(2);
  });

  it('ignores a late manifest response after the selected session changes', async () => {
    let resolveFirst!: (page: AudioManifestPage) => void;
    const api = {
      getAudioManifestPage: vi.fn((sessionId: string) => sessionId === 'a'
        ? new Promise<AudioManifestPage>((resolve) => { resolveFirst = resolve; })
        : Promise.resolve({ ...manifest, chunks: [{ ...manifest.chunks[0]!, sequence: 99 }] })),
      fetchAudio: vi.fn(async () => syntheticPcmWav()),
    };
    const view = render(<DiagnosticAudioPlayer sessionId="a" segments={[]} recording={false} api={api} />);
    view.rerender(<DiagnosticAudioPlayer sessionId="b" segments={[]} recording={false} api={api} />);
    expect(await screen.findByText(/Chunk 99/)).toBeInTheDocument();
    resolveFirst(manifest);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Chunk 4')).not.toBeInTheDocument();
  });

  it('never overlaps manifest polling while recording', async () => {
    vi.useFakeTimers();
    let resolvePoll!: (page: AudioManifestPage) => void;
    const api = {
      getAudioManifestPage: vi.fn()
        .mockResolvedValueOnce(manifest)
        .mockImplementationOnce(() => new Promise<AudioManifestPage>((resolve) => { resolvePoll = resolve; }))
        .mockResolvedValue(manifest),
      fetchAudio: vi.fn(async () => syntheticPcmWav()),
    };
    render(<DiagnosticAudioPlayer sessionId="s1" segments={[]} recording api={api} pollIntervalMs={1_000} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(api.getAudioManifestPage).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.getAudioManifestPage).toHaveBeenCalledTimes(2);
    resolvePoll(manifest);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(api.getAudioManifestPage).toHaveBeenCalledTimes(3);
  });

  it('keeps the same active source and position through unchanged and appended live polls', async () => {
    vi.useFakeTimers();
    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
    const pause = vi.spyOn(audio, 'pause').mockImplementation(() => undefined);
    const play = vi.spyOn(audio, 'play').mockResolvedValue();
    vi.stubGlobal('Audio', vi.fn(() => audio));
    const appended: AudioManifestPage = {
      chunks: [
        { ...manifest.chunks[0]!, status: 'failed' },
        manifest.chunks[1]!,
        { sequence: 12, start_ms: 2_500, end_ms: 3_500, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' },
      ],
      next_after_sequence: null,
    };
    const api = {
      getAudioManifestPage: vi.fn()
        .mockResolvedValueOnce(manifest)
        .mockResolvedValueOnce(manifest)
        .mockResolvedValueOnce(appended),
      fetchAudio: vi.fn(async () => syntheticPcmWav()),
    };
    render(<DiagnosticAudioPlayer sessionId="s1" segments={segments} recording api={api} pollIntervalMs={1_000} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await screen.getByRole('button', { name: /play full recording/i }).click(); });
    const activeSrc = audio.src;
    audio.currentTime = 0.4;
    pause.mockClear();
    (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockClear();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(screen.getByText(/Chunk 12/)).toBeInTheDocument();
    expect(screen.getAllByText('failed')).toHaveLength(2);
    expect(audio.src).toBe(activeSrc);
    expect(audio.currentTime).toBe(0.4);
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('destroys active playback on session change and unmount', async () => {
    const audios: HTMLAudioElement[] = [];
    vi.stubGlobal('Audio', vi.fn(() => {
      const audio = document.createElement('audio');
      Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
      vi.spyOn(audio, 'play').mockResolvedValue();
      vi.spyOn(audio, 'pause').mockImplementation(() => undefined);
      audios.push(audio);
      return audio;
    }));
    const api = { getAudioManifestPage: vi.fn(async () => manifest), fetchAudio: vi.fn(async () => syntheticPcmWav()) };
    const view = render(<DiagnosticAudioPlayer sessionId="s1" segments={segments} recording={false} api={api} />);
    await screen.findByText(/Chunk 4/);
    await act(async () => { await screen.getByRole('button', { name: /play full recording/i }).click(); });
    view.rerender(<DiagnosticAudioPlayer sessionId="s2" segments={segments} recording={false} api={api} />);
    expect(audios[0]!.pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    view.unmount();
    expect(audios[1]!.pause).toHaveBeenCalled();
  });
});
