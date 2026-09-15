import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiClient } from '../../api/client';
import type { AudioChunkManifest, Segment } from '../../api/types';
import { loadAudioManifest, type AudioPlaybackApi } from '../../audio/audioManifest';
import {
  ChunkPlaybackController,
  type PlaybackState,
} from '../../audio/chunkPlayback';
import { formatRange, formatTimecode } from '../../lib/time';

/**
 * Timecode with milliseconds. Timeline gaps are usually sub-second, and
 * second-rounded formatting rendered them as "00:10–00:10", which looks like
 * broken data rather than a real 200 ms hole.
 */
const formatExactMs = (valueMs: number): string =>
  `${formatTimecode(valueMs)}.${String(Math.max(0, Math.round(valueMs)) % 1000).padStart(3, '0')}`;

export interface DiagnosticAudioPlayerHandle {
  playSegment(segmentId: string, withContext: boolean): Promise<void>;
  playSequences(sequences: number[]): Promise<void>;
}

export interface AudioPlaybackPosition {
  /** Position on the recording timeline (pauses excluded) — the same scale
   * as Segment.start_ms/end_ms, regardless of which chunk is playing. */
  timelineMs: number;
  playing: boolean;
}

interface DiagnosticAudioPlayerProps {
  sessionId: string;
  segments: Segment[];
  recording: boolean;
  api?: AudioPlaybackApi;
  pollIntervalMs?: number;
  /** Called whenever the playback position changes, for karaoke-style
   * highlighting of the segment currently sounding. */
  onPlaybackPosition?: (position: AudioPlaybackPosition) => void;
}

const initialPlaybackState: PlaybackState = {
  mode: 'idle',
  playing: false,
  selectedSequence: null,
  sourceSequence: null,
  timelineMs: 0,
  contextStartSequence: null,
  contextEndSequence: null,
  error: null,
};

export const DiagnosticAudioPlayer = forwardRef<
  DiagnosticAudioPlayerHandle,
  DiagnosticAudioPlayerProps
>(function DiagnosticAudioPlayer(
  { sessionId, segments, recording, api: providedApi, pollIntervalMs = 2_000, onPlaybackPosition },
  ref,
) {
  const api = useMemo<AudioPlaybackApi>(
    () => providedApi ?? new ApiClient(window.audiohelper),
    [providedApi],
  );
  const [manifest, setManifest] = useState<{ sessionId: string; chunks: AudioChunkManifest[] }>({
    sessionId,
    chunks: [],
  });
  const chunks = manifest.sessionId === sessionId ? manifest.chunks : [];
  const [loading, setLoading] = useState(true);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [playback, setPlayback] = useState(initialPlaybackState);
  const controllerRef = useRef<ChunkPlaybackController | null>(null);
  const generationRef = useRef(0);
  const refreshInFlightRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    if (refreshInFlightRef.current === generation) return;
    refreshInFlightRef.current = generation;
    try {
      const next = await loadAudioManifest(api, sessionId);
      if (generation !== generationRef.current) return;
      setManifest({ sessionId, chunks: next });
      setManifestError(null);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setManifestError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current) setLoading(false);
      if (refreshInFlightRef.current === generation) refreshInFlightRef.current = null;
    }
  }, [api, sessionId]);

  useEffect(() => {
    generationRef.current += 1;
    setManifest({ sessionId, chunks: [] });
    setLoading(true);
    setManifestError(null);
    setPlayback(initialPlaybackState);
    void refresh();
    return () => {
      generationRef.current += 1;
      refreshInFlightRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    controllerRef.current?.destroy();
    const audio = new Audio();
    const controller = new ChunkPlaybackController({
      sessionId,
      chunks: [],
      audio,
      fetchAudio: (id, sequence) => api.fetchAudio(id, sequence),
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
      onState: setPlayback,
    });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [api, sessionId]);

  useEffect(() => {
    controllerRef.current?.updateChunks(chunks);
  }, [chunks]);

  useEffect(() => {
    onPlaybackPosition?.({ timelineMs: playback.timelineMs, playing: playback.playing });
  }, [onPlaybackPosition, playback.timelineMs, playback.playing]);

  useEffect(() => {
    if (!recording) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(() => { void poll(); }, pollIntervalMs);
    };
    timer = setTimeout(() => { void poll(); }, pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollIntervalMs, recording, refresh]);

  useImperativeHandle(ref, () => ({
    async playSegment(segmentId, withContext) {
      const segment = segments.find((item) => item.id === segmentId);
      await controllerRef.current?.playSegment(
        segmentId,
        withContext,
        segment ? { startMs: segment.start_ms, endMs: segment.end_ms } : undefined,
      );
    },
    async playSequences(sequences) {
      await controllerRef.current?.playSequences(sequences);
    },
  }), [segments]);

  const durationMs = chunks.at(-1)?.end_ms ?? 0;
  const selected = chunks.find((chunk) => chunk.sequence === playback.selectedSequence);
  const linkedSegmentCount = new Set(chunks.flatMap((chunk) => chunk.segment_ids)).size;
  const timelineGaps = chunks.flatMap((chunk, index) => {
    const next = chunks[index + 1];
    return next && next.start_ms > chunk.end_ms
      ? [{ afterSequence: chunk.sequence, startMs: chunk.end_ms, endMs: next.start_ms }]
      : [];
  });

  return (
    <section className="audio-player" aria-label="Diagnostic audio">
      <div className="audio-player__head">
        <div>
          <h3>Diagnostic audio</h3>
          <p>Original captured WAV · model input unknown (exact transformed bytes not stored)</p>
        </div>
        <button type="button" className="audio-player__refresh" onClick={() => { void refresh(); }}>
          Refresh audio
        </button>
      </div>

      {recording && (
        <p className="audio-player__warning" role="status">
          Use headphones while recording to reduce speaker feedback before you start playback.
        </p>
      )}
      {manifestError && <p className="audio-player__error" role="alert">{manifestError}</p>}

      <div className="audio-player__controls">
        <button
          type="button"
          onClick={() => { void controllerRef.current?.playFull(); }}
          disabled={loading || chunks.length === 0}
        >
          Play full recording
        </button>
        <button
          type="button"
          onClick={() => {
            if (playback.playing) controllerRef.current?.pause();
            else void controllerRef.current?.resume();
          }}
          disabled={playback.selectedSequence === null}
        >
          {playback.playing ? 'Pause' : 'Resume'}
        </button>
        <label>
          Timeline {formatTimecode(playback.timelineMs)}
          <input
            aria-label="Recording timeline"
            type="range"
            min={0}
            max={Math.max(1, durationMs)}
            value={Math.min(durationMs, playback.timelineMs)}
            onChange={(event) => { void controllerRef.current?.seek(Number(event.currentTarget.value)); }}
            disabled={chunks.length === 0}
          />
        </label>
      </div>

      {selected && (
        <p className="audio-player__selection" aria-live="polite">
          Selected exact chunk {selected.sequence} · {formatRange(selected.start_ms, selected.end_ms)} · {playback.mode}
          {playback.mode === 'context'
            ? ` (source chunk ${playback.sourceSequence}; context ${playback.contextStartSequence}–${playback.contextEndSequence})`
            : ''}
        </p>
      )}
      {playback.error && <p className="audio-player__error" role="alert">{playback.error}</p>}
      {timelineGaps.length > 0 && (
        <details className="audio-player__issues-wrap">
          <summary className="audio-player__issues-summary">
            {timelineGaps.length} timeline {timelineGaps.length === 1 ? 'gap' : 'gaps'} with no captured file
          </summary>
          <ul className="audio-player__issues" aria-label="Audio timeline gaps">
            {timelineGaps.map((gap) => (
              <li key={`${gap.afterSequence}-${gap.startMs}`}>
                {/* Millisecond precision on purpose: most of these gaps are
                    sub-second, and second-rounded output printed them as
                    "00:10–00:10", which reads like a bug in the data. */}
                Gap {formatExactMs(gap.startMs)}–{formatExactMs(gap.endMs)} ({gap.endMs - gap.startMs} ms)
                {' '}after chunk {gap.afterSequence}: no captured file.
              </li>
            ))}
          </ul>
        </details>
      )}

      {loading ? (
        <p className="audio-player__empty">Loading captured audio…</p>
      ) : chunks.length === 0 ? (
        <p className="audio-player__empty">No captured audio chunks are stored for this session.</p>
      ) : (
        <ol className="audio-player__chunks" aria-label="Captured chunk boundaries">
          {chunks.map((chunk) => (
            <li
              key={chunk.sequence}
              className={chunk.sequence === playback.selectedSequence ? 'audio-player__chunk audio-player__chunk--selected' : 'audio-player__chunk'}
            >
              <span>Chunk {chunk.sequence}</span>
              <span>{formatRange(chunk.start_ms, chunk.end_ms)}</span>
              <span>{chunk.status}</span>
              {!chunk.available && <strong>missing file</strong>}
            </li>
          ))}
        </ol>
      )}
      <p className="audio-player__meta">
        {chunks.length} captured chunk{chunks.length === 1 ? '' : 's'} · {linkedSegmentCount}/{segments.length} transcript links
      </p>
    </section>
  );
});
