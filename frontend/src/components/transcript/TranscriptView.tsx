import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useStore, type LanguageMark } from '../../state/store';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { formatTimecode } from '../../lib/time';
import type { Segment } from '../../api/types';
import { useNativeTranscript } from './useNativeTranscript';
import { NativeTranscriptStatus } from './NativeTranscriptStatus';
import { NativeMonologues } from './NativeMonologues';
import {
  DiagnosticAudioPlayer,
  type AudioPlaybackPosition,
  type DiagnosticAudioPlayerHandle,
} from '../audio/DiagnosticAudioPlayer';

/** How long an autoscroll suppresses itself after the user scrolls by hand. */
const MANUAL_SCROLL_QUIET_MS = 4_000;
/** How long a programmatic scroll is allowed to run before its own 'scroll'
 * events stop being treated as "the user just scrolled". */
const AUTO_SCROLL_SETTLE_MS = 700;

const prefersReducedMotion = (): boolean => (
  typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
);

/** The plain-text SKAZ wordmark shown when a session has no transcript yet
 * and nothing is currently recording. Text only — no icon, no image. */
function TranscriptEmptyLogo() {
  return (
    <div className="transcript-logo">
      <h2 className="transcript-logo__mark">
        <span className="transcript-logo__skaz">SKAZ</span>{' '}
        <span className="transcript-logo__agent">AGENT</span>
      </h2>
      <p className="transcript-logo__hint">Record or open a session to see its transcript here.</p>
    </div>
  );
}

interface TranscriptViewProps {
  focusSegmentId: string | null;
}

interface FragmentEdit {
  fragmentId: string;
  text: string;
  expectedRevision: number;
  rangeFingerprint: string;
}

const formatFragmentTime = (valueMs: number): string => (
  `${formatTimecode(valueMs)}.${String(Math.max(0, valueMs) % 1_000).padStart(3, '0')}`
);

const readableReason = (reason: string | null | undefined): string | null => (
  reason ? reason.replaceAll('_', ' ') : null
);

type TimelineItem =
  | { kind: 'segment'; segment: Segment }
  | { kind: 'mark'; mark: LanguageMark };

// Interleaves permanent client-side language-switch markers into the
// segment timeline by comparing their recording-timeline timestamps. A mark
// only says "the operator chose a different recognition language from this
// point on" — it never claims the backend re-recognized anything before it.
function withLanguageMarks(segments: Segment[], marks: LanguageMark[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let markIndex = 0;
  for (const segment of segments) {
    while (markIndex < marks.length && marks[markIndex]!.atMs <= segment.start_ms) {
      items.push({ kind: 'mark', mark: marks[markIndex]! });
      markIndex += 1;
    }
    items.push({ kind: 'segment', segment });
  }
  while (markIndex < marks.length) {
    items.push({ kind: 'mark', mark: marks[markIndex]! });
    markIndex += 1;
  }
  return items;
}

function LanguageMarkRow({ mark }: { mark: LanguageMark }) {
  return (
    <span>── {mark.language.toUpperCase()} from {formatTimecode(mark.atMs)} ──</span>
  );
}

export function TranscriptView({ focusSegmentId }: TranscriptViewProps) {
  const detail = useStore((s) => s.detail);
  const loading = useStore((s) => s.detailLoading);
  const error = useStore((s) => s.detailError);
  const recorderState = useStore((s) => s.recorderState);
  const queue = useStore((s) => s.queue);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const draft = useStore((s) => s.liveDraft);
  const fragments = useStore((s) => s.liveFragments);
  const languageMarks = useStore((s) => s.languageMarks);
  const sourceIntegrity = useStore((s) => s.liveSourceIntegrity);
  const resumeCompatibility = useStore((s) => s.liveResumeCompatibility);
  const scheduler = useStore((s) => s.liveScheduler);
  const liveError = useStore((s) => s.liveError);
  const capabilities = useStore((s) => s.liveCapabilities);
  const refreshContextualLive = useStore((s) => s.refreshContextualLive);
  const resumeContextualProcessing = useStore((s) => s.resumeContextualProcessing);
  const editLiveFragment = useStore((s) => s.editLiveFragment);
  const acceptLiveFragment = useStore((s) => s.acceptLiveFragment);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const playerRef = useRef<DiagnosticAudioPlayerHandle>(null);
  const [fragmentEdit, setFragmentEdit] = useState<FragmentEdit | null>(null);
  const [savingFragmentId, setSavingFragmentId] = useState<string | null>(null);
  const [acceptingFragmentId, setAcceptingFragmentId] = useState<string | null>(null);
  // Diagnostics are an investigation tool, not daily reading — collapsed by
  // default so the transcript gets the room.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [followSpeech, setFollowSpeech] = useState(true);
  const [dismissedFocus, setDismissedFocus] = useState<string | null>(null);
  const [playbackPosition, setPlaybackPosition] = useState<AudioPlaybackPosition>({
    timelineMs: 0,
    playing: false,
  });
  // Distinguishes a user-initiated scroll from the karaoke autoscroll's own
  // 'scroll' events, and gives the user a quiet window after they scroll by
  // hand before autoscroll resumes fighting them for control.
  const manualScrollUntilRef = useRef(0);
  const autoScrollingRef = useRef(false);

  const onPlaybackPosition = useCallback((position: AudioPlaybackPosition) => {
    setPlaybackPosition(position);
  }, []);

  const contextual = sessions.find((session) => session.id === activeSessionId)?.mode === 'contextual_local';
  const native = useNativeTranscript(contextual ? null : activeSessionId, ['recording', 'processing'].includes(recorderState));
  const segments = (native.segments ?? detail?.segments ?? []).filter((segment) => segment.text.trim().length > 0);
  const cleanNative = native.snapshot?.final_tokens !== undefined || native.snapshot?.recording_mode === 'translation';
  const hasDraftText = fragments.length === 0 && Boolean(draft?.text.trim());
  const sourceTrusted = sourceIntegrity?.trusted ?? true;
  const live = recorderState === 'recording';
  const contextualRecoveryNeeded = Boolean(
    liveError || scheduler?.recovery_required || scheduler?.status === 'stalled',
  );

  // DiagnosticAudioPlayer reports timelineMs on the same recording timeline
  // as Segment.start_ms/end_ms (see ChunkPlaybackController), whether it is
  // playing one chunk, a segment-with-context, or the full recording — so a
  // direct range comparison is exact, not an approximation across
  // mismatched clocks. Only lit while audio is actually sounding.
  const activeSegmentId = useMemo(() => {
    if (!playbackPosition.playing) return null;
    const ms = playbackPosition.timelineMs;
    return segments.find((segment) => ms >= segment.start_ms && ms < segment.end_ms)?.id ?? null;
  }, [playbackPosition, segments]);

  // Track manual scrolling on the transcript pane so karaoke autoscroll
  // backs off instead of fighting the reader. Our own programmatic scrolls
  // are excluded via autoScrollingRef so they don't arm this guard.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      if (autoScrollingRef.current) return;
      manualScrollUntilRef.current = Date.now() + MANUAL_SCROLL_QUIET_MS;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Karaoke autoscroll: bring the sounding segment into view, but only when
  // it is not already visible and the reader has not just scrolled by hand.
  useEffect(() => {
    if (!activeSegmentId) return undefined;
    if (Date.now() < manualScrollUntilRef.current) return undefined;
    const row = rowRefs.current.get(activeSegmentId);
    const container = scrollRef.current;
    if (!row || !container) return undefined;
    const rowRect = row.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const alreadyVisible = rowRect.top >= containerRect.top && rowRect.bottom <= containerRect.bottom;
    if (alreadyVisible) return undefined;
    autoScrollingRef.current = true;
    row.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const settle = setTimeout(() => { autoScrollingRef.current = false; }, AUTO_SCROLL_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [activeSegmentId]);

  useEffect(() => {
    if (!activeSessionId || !contextual) return undefined;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      await refreshContextualLive(activeSessionId);
      inFlight = false;
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 2_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (useStore.getState().activeSessionId === activeSessionId) {
        useStore.setState({ liveDraft: null, liveFragments: [], liveScheduler: null, liveError: null });
      }
    };
  }, [activeSessionId, contextual, refreshContextualLive]);

  // Auto-scroll to the newest segment while live.
  useEffect(() => {
    if (live && !cleanNative && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segments.length, live, cleanNative]);

  useEffect(() => { setFollowSpeech(true); }, [activeSessionId]);
  useEffect(() => { if (focusSegmentId) setFollowSpeech(false); }, [focusSegmentId]);
  useEffect(() => {
    if (cleanNative && live && followSpeech && (!focusSegmentId || dismissedFocus === focusSegmentId) && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [native.snapshot, cleanNative, live, followSpeech, focusSegmentId, dismissedFocus]);

  // Scroll a cited segment into view and flash it.
  useEffect(() => {
    if (!focusSegmentId) return;
    const row = rowRefs.current.get(focusSegmentId);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('segment--flash');
      const timer = setTimeout(() => row.classList.remove('segment--flash'), 1600);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [focusSegmentId]);

  return (
    <div className={clsx('transcript-layout', cleanNative && 'transcript-layout--native')}>
      {!cleanNative && activeSessionId && (
        <div className="transcript__diagnostics">
          <button
            type="button"
            className="transcript__diag-toggle"
            onClick={() => setDiagnosticsOpen((open) => !open)}
            aria-expanded={diagnosticsOpen}
            aria-controls="diagnostic-audio-panel"
            title={diagnosticsOpen ? 'Hide diagnostic audio' : 'Show diagnostic audio'}
          >
            <Icon name="sliders" size={15} />
            Diagnostic audio
          </button>
          {/* Kept mounted while hidden: the player owns playback state and the
              karaoke position feed, so unmounting it would stop audio and drop
              the highlight the moment the panel is collapsed. */}
          <div id="diagnostic-audio-panel" hidden={!diagnosticsOpen}>
            {cleanNative && <NativeTranscriptStatus snapshot={native.snapshot} error={null} finalizing={recorderState === 'processing'} onRetry={native.retry} />}
            <DiagnosticAudioPlayer
              ref={playerRef}
              sessionId={activeSessionId}
              segments={segments}
              recording={live}
              onPlaybackPosition={onPlaybackPosition}
            />
          </div>
        </div>
      )}
      {cleanNative && <div className="native-transcript-notice">
        {native.error ? <div role="alert"><span>{native.error}</span>{' '}
          <button type="button" onClick={native.retry}>Обновить текст</button>
        </div> : native.snapshot?.recording_mode === 'audio_only' ? null : native.snapshot?.transcription === 'unavailable' ? (
          <span role="alert">Сбой распознавания. Soniox недоступен.</span>
        ) : native.snapshot?.gaps.length ? (
          <span role="status">В транскрипции есть пропуски.</span>
        ) : recorderState === 'processing' ? <span role="status">Завершаем обработку…</span> : null}
      </div>}
      <div className="transcript" ref={scrollRef} onScroll={(event) => {
        if (!cleanNative) return;
        const element = event.currentTarget;
        setFollowSpeech(element.scrollHeight - element.clientHeight - element.scrollTop < 48);
      }}>
        {!cleanNative && <NativeTranscriptStatus snapshot={native.snapshot} error={native.error} finalizing={recorderState === 'processing'} onRetry={native.retry} />}

        {loading ? (
          <div className="panel__center"><p className="loading">Loading transcript…</p></div>
        ) : error ? (
          <div className="panel__center">
            <EmptyState icon="warning" title="Couldn’t load the transcript" hint={error} />
          </div>
        ) : cleanNative && native.snapshot ? (
          <NativeMonologues key={native.snapshot.session_id} snapshot={native.snapshot} segments={segments} focusSegmentId={focusSegmentId} />
        ) : segments.length === 0 && (!contextual || (!hasDraftText && fragments.length === 0)) ? (
          <div className="panel__center">
            {live ? (
              <EmptyState
                icon="transcript"
                title={native.snapshot ? "No confirmed transcript yet" : "Listening…"}
                hint={native.snapshot ? "Recording and transcription have separate statuses above." : "Words appear here moments after they are spoken."}
              />
            ) : (
              <TranscriptEmptyLogo />
            )}
          </div>
        ) : (
          <ol
            className={clsx('transcript__list', contextual && 'transcript__list--contextual')}
            role="list"
            aria-label={contextual ? 'Contextual flowing transcript' : undefined}
          >
            {contextual ? (
              <li className="transcript__flow">
                {withLanguageMarks(segments, languageMarks).map((item) => item.kind === 'mark' ? (
                  <span
                    key={`mark-${item.mark.atMs}-${item.mark.language}`}
                    className="transcript__lang-mark"
                  >
                    <LanguageMarkRow mark={item.mark} />
                  </span>
                ) : (
                  <span
                    key={item.segment.id}
                    className={clsx(
                      'transcript__final-fragment',
                      focusSegmentId === item.segment.id && 'segment--focused',
                      activeSegmentId === item.segment.id && 'segment--playing',
                    )}
                    ref={(element) => {
                      if (element) rowRefs.current.set(item.segment.id, element);
                      else rowRefs.current.delete(item.segment.id);
                    }}
                  >
                    <button
                      type="button"
                      className="transcript__source-link tabular"
                      onClick={() => { void playerRef.current?.playSegment(item.segment.id, false); }}
                      aria-label={`Play source at ${formatTimecode(item.segment.start_ms)}`}
                    >
                      {formatTimecode(item.segment.start_ms)}
                    </button>{' '}
                    {item.segment.text}{' '}
                  </span>
                ))}
                {hasDraftText && draft && draft.text_scope !== 'whole_window' && (
                  <span className="transcript__draft-inline" aria-label="Revisable transcript draft">
                    <button
                      type="button"
                      className="transcript__source-link"
                      disabled={!sourceTrusted}
                      onClick={() => { void playerRef.current?.playSequences(draft.sources.map((source) => source.sequence)); }}
                    >
                      Draft sources
                    </button>{' '}
                    <span className="transcript__draft-text">{draft.text}</span>
                  </span>
                )}
              </li>
            ) : withLanguageMarks(segments, languageMarks).map((item) => item.kind === 'mark' ? (
              <li
                key={`mark-${item.mark.atMs}-${item.mark.language}`}
                className="transcript__lang-mark"
              >
                <LanguageMarkRow mark={item.mark} />
              </li>
            ) : (
              <li
                key={item.segment.id}
                className={clsx(
                  'segment',
                  focusSegmentId === item.segment.id && 'segment--focused',
                  activeSegmentId === item.segment.id && 'segment--playing',
                )}
                ref={(el) => {
                  if (el) rowRefs.current.set(item.segment.id, el);
                  else rowRefs.current.delete(item.segment.id);
                }}
              >
                <div className="segment__audio-actions">
                  <button
                    type="button"
                    className="segment__time tabular"
                    onClick={() => { void playerRef.current?.playSegment(item.segment.id, false); }}
                    aria-label={`Play source chunk at ${formatTimecode(item.segment.start_ms)}`}
                  >
                    {formatTimecode(item.segment.start_ms)}
                  </button>
                  <button
                    type="button"
                    className="segment__context"
                    onClick={() => { void playerRef.current?.playSegment(item.segment.id, true); }}
                  >
                    With context
                  </button>
                </div>
                <p className="segment__text">
                  {item.segment.text}
                  {item.segment.language && <span className="segment__lang">{item.segment.language}</span>}
                </p>
              </li>
            ))}
          </ol>
        )}
        {contextual && fragments.length > 0 && (
          <section className="transcript__fragments" aria-label="Revisable transcript fragments">
            {fragments.map((fragment) => {
              const editing = fragmentEdit?.fragmentId === fragment.fragment_id;
              const saving = savingFragmentId === fragment.fragment_id;
              const accepting = acceptingFragmentId === fragment.fragment_id;
              const editReason = readableReason(fragment.edit_disabled_reason);
              const acceptReason = readableReason(fragment.accept_disabled_reason);
              return (
                <article className="transcript__fragment" key={fragment.fragment_id}>
                  <div className="transcript__fragment-meta">
                    <span className="tabular">
                      {formatFragmentTime(fragment.start_ms)}–{formatFragmentTime(fragment.protected_through_ms)}
                    </span>
                    <span>{fragment.state === 'complete' ? 'Processing complete' : fragment.state === 'error' ? 'Needs recovery' : 'Revisable'}</span>
                  </div>
                  {editing && fragmentEdit ? (
                    <textarea
                      aria-label="Edit fragment"
                      className="transcript__fragment-editor"
                      disabled={saving}
                      value={fragmentEdit.text}
                      onChange={(event) => {
                        const text = event.currentTarget.value;
                        setFragmentEdit((current) => current ? { ...current, text } : current);
                      }}
                    />
                  ) : fragment.state !== 'complete' || !fragment.segment_id ? (
                    <p className="transcript__draft-text">{fragment.text}</p>
                  ) : null}
                  <div className="transcript__fragment-actions">
                    {editing && fragmentEdit ? (
                      <>
                        <button
                          type="button"
                          className="btn btn--primary"
                          disabled={saving || !fragmentEdit.text.trim()}
                          aria-label={saving ? 'Saving edit' : 'Save edit'}
                          onClick={() => {
                            setSavingFragmentId(fragment.fragment_id);
                            void editLiveFragment(
                              fragment.fragment_id,
                              fragmentEdit.text,
                              fragmentEdit.expectedRevision,
                              fragmentEdit.rangeFingerprint,
                            ).then(() => {
                              setFragmentEdit(null);
                            }).catch(() => undefined).finally(() => {
                              setSavingFragmentId(null);
                            });
                          }}
                        >
                          {saving ? 'Saving edit…' : 'Save edit'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={saving}
                          onClick={() => setFragmentEdit(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        aria-label="Edit draft"
                        disabled={!fragment.can_edit || saving}
                        title={editReason ?? undefined}
                        onClick={() => setFragmentEdit({
                          fragmentId: fragment.fragment_id,
                          text: fragment.text,
                          expectedRevision: fragment.revision,
                          rangeFingerprint: fragment.range_fingerprint,
                        })}
                      >
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--quiet"
                      aria-label={fragment.state === 'complete' ? 'Accept fragment' : 'Accept draft'}
                      disabled={!fragment.can_accept || accepting}
                      title={acceptReason ?? undefined}
                      onClick={() => {
                        setAcceptingFragmentId(fragment.fragment_id);
                        void acceptLiveFragment(
                          fragment.fragment_id,
                          fragment.revision,
                          fragment.range_fingerprint,
                        ).catch(() => undefined).finally(() => {
                          setAcceptingFragmentId(null);
                        });
                      }}
                    >
                      {accepting ? 'Accepting…' : fragment.accepted_at ? 'Accepted' : 'Accept'}
                    </button>
                  </div>
                  {!fragment.can_edit && editReason && fragment.state !== 'complete' && (
                    <p className="transcript__fragment-status">Edit unavailable: {editReason}</p>
                  )}
                  {!fragment.can_accept && !fragment.accepted_at && acceptReason && (
                    <p className="transcript__fragment-status">Accept unavailable: {acceptReason}</p>
                  )}
                </article>
              );
            })}
          </section>
        )}
        {contextual && draft?.text_scope === 'whole_window' && (
          <div className="transcript__conflict" role="alert">
            <strong>Draft conflicts with the stable prefix; it is shown separately.</strong>
            <p className="transcript__draft-text">{draft.text}</p>
            <button type="button" disabled={!sourceTrusted} onClick={() => { void playerRef.current?.playSequences(draft.sources.map((source) => source.sequence)); }}>
              Play draft sources
            </button>
          </div>
        )}
        {contextual && sourceIntegrity && !sourceIntegrity.trusted && (
          <div className="transcript__conflict" role="alert">
            <strong>Historical draft retained, but its source audio is not trusted.</strong>
            <p>{sourceIntegrity.detail ?? `Source integrity: ${sourceIntegrity.status}`}</p>
          </div>
        )}
        {contextual && resumeCompatibility?.requires_redecode && (
          <p className="transcript__draft-warning">
            {resumeCompatibility.detail ?? 'Current ASR settings differ; explicit resume must re-decode the saved source.'}
          </p>
        )}
        {contextual && scheduler && (
          <>
            <div className="transcript__progress" aria-label="Contextual transcription progress">
              <span>Captured {formatTimecode(scheduler.stable_frontier_ms + (scheduler.lag_ms ?? 0))}</span>
              <span>Processed {formatTimecode(scheduler.processed_window?.end_ms ?? 0)}</span>
              <span>Stable {formatTimecode(scheduler.stable_frontier_ms)}</span>
              <strong>
                {scheduler.status === 'complete' && (scheduler.lag_ms ?? 0) > 0
                  ? 'Available audio processed; draft remains'
                  : scheduler.status === 'stalled'
                    ? `Processing stalled${scheduler.block_reason ? `: ${scheduler.block_reason}` : ''}`
                    : `Contextual processing: ${scheduler.status}`}
              </strong>
            </div>
            {scheduler.source_continuity_verified === false && (
              <p className="transcript__draft-warning">
                Source continuity beyond the bounded preview is unverified; no source gap is claimed.
              </p>
            )}
          </>
        )}
        {contextual && (
          <p className="transcript__draft-warning">
            Revisable draft text is excluded from Q&A, citations, and notes until it becomes final.
          </p>
        )}
        {contextual && (recorderState !== 'recording' || contextualRecoveryNeeded) && (
          <button
            type="button"
            className="transcript__resume"
            disabled={!capabilities?.capable || resumeCompatibility?.can_resume === false}
            onClick={() => { void resumeContextualProcessing(); }}
          >
            Resume contextual processing
          </button>
        )}
        {contextual && liveError && <p className="transcript__error" role="alert">{liveError}</p>}
        {live && !cleanNative && (
          <p className="transcript__live" aria-live="polite">
            <span className="transcript__pulse" aria-hidden />
            {queue.pending > 0 ? `Transcribing ${queue.pending} chunk${queue.pending > 1 ? 's' : ''}…` : 'Listening…'}
          </p>
        )}
      </div>
      {cleanNative && !followSpeech && <button type="button" className="transcript__follow" onClick={() => {
        setDismissedFocus(focusSegmentId);
        setFollowSpeech(true);
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }}>К текущей речи</button>}
    </div>
  );
}
