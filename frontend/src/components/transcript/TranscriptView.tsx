import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useStore, type LanguageMark } from '../../state/store';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { formatTimecode } from '../../lib/time';
import type { Segment } from '../../api/types';
import { useNativeTranscript } from './useNativeTranscript';
import { peekTranscript, type ReadingPlace } from './transcriptCache';
import { ApiClient } from '../../api/client';
import { mediaSourceLink } from '../../lib/mediaSourceLink';
import { NativeMonologues } from './NativeMonologues';
import { useTranscriptIssue } from '../../state/transcriptIssue';
import type { NativeSnapshot } from '../../api/nativeLive';
import { useEdgeFade } from '../../hooks/useOverflowEdges';

const PROVIDER_LABELS: Record<string, string> = {
  soniox: 'Soniox', 'local-whisper': 'Local Whisper', openai: 'OpenAI',
};

/** The provider the snapshot names; older backends only ever used Soniox. */
const providerLabel = (snapshot: NativeSnapshot | null | undefined): string =>
  PROVIDER_LABELS[snapshot?.transcription_provider ?? 'soniox'] ?? 'Transcription';

function transcriptionStatus(snapshot: NativeSnapshot | null): string {
  const label = providerLabel(snapshot);
  const loading = snapshot?.transcription_provider === 'local-whisper' ? 'loading the model' : 'connecting';
  const status: Record<NativeSnapshot['transcription'], string> = {
    connecting: `${label}: ${loading}`,
    reconnecting: `${label}: reconnecting`,
    streaming: `${label}: transcribing`,
    unavailable: `${label}: transcription unavailable — audio is still saved locally`,
    inactive: `${label}: not active`,
    disabled: 'Audio-only recording — transcription is disabled',
  };
  return snapshot?.recording_mode === 'audio_only' ? status.disabled : status[snapshot?.transcription ?? 'connecting'];
}

/** Whether a native snapshot holds any text to read (confirmed, tail or translation). */
const hasWords = (snapshot: NativeSnapshot): boolean =>
  (snapshot.final_tokens?.length ?? 0) > 0 || (snapshot.final_translation_tokens?.length ?? 0) > 0;

/** Capturing, but no word has arrived yet: one static state, no pulse, no
 * second screen. The recording may not even exist on the server yet. */
function WaitingForWords({ snapshot }: { snapshot: NativeSnapshot | null }) {
  const status = transcriptionStatus(snapshot);
  return (
    <div className="panel__center">
      <EmptyState icon="transcript" title="Recording — waiting for first words" hint={status} />
    </div>
  );
}

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

/** Delay after which a still-running load earns the animated loader: shorter
 * opens finish before anything is drawn, so a fast switch never flickers. */
const LOADER_DELAY_MS = 300;

function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return undefined; }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

/** Opening a saved session: the SKAZ wordmark inside a slowly turning arc.
 * Reduced motion swaps the rotation for a gentle pulse (CSS only). */
function TranscriptLoading() {
  return (
    <div className="transcript-loading" role="status" aria-label="Loading transcript">
      <div className="transcript-loading__ring" aria-hidden="true">
        <svg className="transcript-loading__arc" viewBox="0 0 120 120">
          <circle className="transcript-loading__track" cx="60" cy="60" r="54" />
          <circle className="transcript-loading__sweep" cx="60" cy="60" r="54" pathLength="100" />
        </svg>
        <span className="transcript-loading__mark">SKAZ</span>
      </div>
      <p className="transcript-loading__hint" aria-hidden="true">Opening transcript…</p>
    </div>
  );
}

interface TranscriptViewProps {
  focusSegmentId: string | null;
}

/**
 * Owns the audio-queue subscription so the transcript does not — used only by
 * the experimental contextual mode, which has no Soniox stream to report.
 *
 * Capture emits a chunk every 100 ms and the persistence queue reports state
 * several times per chunk, so this text changes ~40x/second. Subscribing to it
 * from TranscriptView made every audio save re-render — and re-project — the
 * whole transcript (ТЗ, Задача 2; docs/BASELINE-PROFILE.md).
 */
function LiveQueueStatus() {
  const pending = useStore((s) => s.queue.pending);
  return (
    <p className="transcript__live" aria-live="polite">
      <span className="transcript__pulse" aria-hidden />
      {pending > 0 ? `Transcribing ${pending} chunk${pending > 1 ? 's' : ''}…` : 'Listening…'}
    </p>
  );
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
  // Only the segments, not the whole `detail`: a durable audio save rebuilds
  // that object ~10x/second to flag notes stale, and subscribing to it made
  // every saved chunk re-project the transcript (ТЗ, Задача 2).
  const detailSegments = useStore((s) => s.detail?.segments);
  const loading = useStore((s) => s.detailLoading);
  const error = useStore((s) => s.detailError);
  const recorderState = useStore((s) => s.recorderState);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const draft = useStore((s) => s.liveDraft);
  const fragments = useStore((s) => s.liveFragments);
  const languageMarks = useStore((s) => s.languageMarks);
  const sourceIntegrity = useStore((s) => s.liveSourceIntegrity);
  const resumeCompatibility = useStore((s) => s.liveResumeCompatibility);
  const scheduler = useStore((s) => s.liveScheduler);
  const liveError = useStore((s) => s.liveError);
  const refreshContextualLive = useStore((s) => s.refreshContextualLive);
  const editLiveFragment = useStore((s) => s.editLiveFragment);
  const acceptLiveFragment = useStore((s) => s.acceptLiveFragment);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Top/bottom fade where transcript is scrolled away (PANES-SPEC §5).
  useEdgeFade(scrollRef);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [fragmentEdit, setFragmentEdit] = useState<FragmentEdit | null>(null);
  const [savingFragmentId, setSavingFragmentId] = useState<string | null>(null);
  const [acceptingFragmentId, setAcceptingFragmentId] = useState<string | null>(null);
  const [followSpeech, setFollowSpeech] = useState(() => {
    const cached = peekTranscript(activeSessionId);
    return cached?.ready ? cached.follow : true;
  });
  const [dismissedFocus, setDismissedFocus] = useState<string | null>(null);

  const [videoId, setVideoId] = useState<string | null>(null);
  const imported = sessions.find((session) => session.id === activeSessionId)?.origin === 'import';
  useEffect(() => {
    let current = true;
    setVideoId(null);
    if (imported && activeSessionId) void new ApiClient(window.skaz).getImport(activeSessionId)
      .then((value) => { if (current) setVideoId(value.source.video_id ?? null); }).catch(() => undefined);
    return () => { current = false; };
  }, [activeSessionId, imported]);
  const contextual = sessions.find((session) => session.id === activeSessionId)?.mode === 'contextual_local';
  const native = useNativeTranscript(contextual ? null : activeSessionId,
    ['recording', 'processing'].includes(recorderState), followSpeech,
    dismissedFocus === focusSegmentId ? null : focusSegmentId);

  // Critical transcript problems go to the recorder capsule as one line with
  // their action; the transcript itself carries no notice strip (UI-CLEANUP §1).
  const reportIssue = useTranscriptIssue((s) => s.report);
  const unavailable = native.snapshot?.recording_mode !== 'audio_only' && native.snapshot?.transcription === 'unavailable';
  const retryRef = useRef(native.retry);
  retryRef.current = native.retry;
  useEffect(() => {
    if (!activeSessionId) { reportIssue(null); return undefined; }
    reportIssue(native.error
      ? { sessionId: activeSessionId, message: native.error, action: { label: 'Retry', run: () => retryRef.current() } }
      : unavailable ? {
        sessionId: activeSessionId,
        message: `Recognition failed. ${providerLabel(native.snapshot)} is unavailable.${
          native.snapshot?.transcription_detail ? ` ${native.snapshot.transcription_detail}` : ''}`,
        action: null,
      }
        : null);
    return undefined;
  }, [activeSessionId, native.error, unavailable, reportIssue, native.snapshot?.transcription_provider,
    native.snapshot?.transcription_detail]);
  useEffect(() => () => reportIssue(null), [reportIssue]);
  /** Per-part reading places live in the transcript cache so a return restores them. */
  const fallbackPlaces = useRef(new Map<string, ReadingPlace>());
  const readingPlaces = () => peekTranscript(activeSessionId)?.places ?? fallbackPlaces.current;
  const partDirection = useRef<'older' | 'newer' | null>(null);
  const navigationUntil = useRef(0);
  const touchY = useRef<number | null>(null);
  const readingPlace = (container: HTMLElement): ReadingPlace => ({
    top: container.scrollTop,
    open: new Set(Array.from(container.querySelectorAll('details[open] [data-native-anchor]'))
      .map(node => (node as HTMLElement).dataset.nativeAnchor!)),
  });
  const restorePlace = (container: HTMLElement, place: ReadingPlace) => {
    for (const node of container.querySelectorAll<HTMLElement>('details [data-native-anchor]')) {
      if (place.open.has(node.dataset.nativeAnchor!)) node.closest('details')!.open = true;
    }
    container.scrollTop = place.top;
  };
  const loadPart = (direction: 'older' | 'newer') => {
    if (native.busy) return;
    const container = scrollRef.current;
    if (container && native.part) readingPlaces().set(native.part.id, readingPlace(container));
    partDirection.current = direction;
    navigationUntil.current = Date.now() + 450;
    setFollowSpeech(false);
    setDismissedFocus(focusSegmentId);
    native[direction]();
  };
  const scrollAcrossPart = (delta: number) => {
    const container = scrollRef.current;
    if (!native.windowed || !container || Date.now() < navigationUntil.current) return;
    if (delta < 0 && container.scrollTop <= 2 && native.hasOlder) loadPart('older');
    else if (delta > 0 && container.scrollHeight - container.clientHeight - container.scrollTop <= 2 && native.hasNewer) loadPart('newer');
  };
  // Leaving the transcript (Notes tab, another session) remembers where the
  // reader stood; a return from the cache shows the end while following speech,
  // otherwise the same part at the same place.
  const partId = useRef<string | null>(null);
  partId.current = native.part?.id ?? null;
  useEffect(() => {
    const entry = peekTranscript(activeSessionId);
    if (entry) entry.follow = followSpeech;
  }, [activeSessionId, followSpeech, native.part?.id]);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const id = partId.current;
    if (container && id) {
      const place = readingPlaces().get(id);
      if (followSpeech) container.scrollTop = container.scrollHeight;
      else if (place) restorePlace(container, place);
    }
    return () => {
      const current = partId.current;
      const entry = peekTranscript(activeSessionId);
      if (container && current && entry?.parts.some(part => part.id === current)) {
        entry.places.set(current, readingPlace(container));
      }
    };
    // Mount/unmount only: part navigation restores places below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !native.part || !partDirection.current) return;
    const position = readingPlaces().get(native.part.id);
    if (position) restorePlace(container, position);
    else container.scrollTop = partDirection.current === 'older'
      ? Math.max(0, container.scrollHeight - container.clientHeight - 48) : 48;
    partDirection.current = null;
  }, [native.part?.id]);
  // Memoised: a fresh array on every render would defeat NativeMonologues'
  // own projection memo, so unrelated re-renders would re-project the
  // transcript even when no word changed.
  const nativeSegments = native.segments;
  const segments = useMemo(
    () => (nativeSegments ?? detailSegments ?? []).filter((segment) => segment.text.trim().length > 0),
    [nativeSegments, detailSegments],
  );
  const cleanNative = native.snapshot?.final_tokens !== undefined || native.snapshot?.recording_mode === 'translation';
  const hasDraftText = fragments.length === 0 && Boolean(draft?.text.trim());
  const live = recorderState === 'recording';
  // Opening a saved session: the detail read or the first native page is still in
  // flight. During capture the transcript is being written, not opened.
  const capturing = ['recording', 'paused', 'processing'].includes(recorderState);
  // Capture never shows the opening loader: the static waiting state covers it,
  // so starting a recording cannot flicker loader → logo → text.
  const opening = capturing && !contextual ? false
    : loading || (!capturing && !contextual && native.initializing);
  const showLoader = useDelayedFlag(opening, LOADER_DELAY_MS);
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

  // A new session starts following speech; the mount keeps the cached choice.
  const followSession = useRef(activeSessionId);
  useEffect(() => {
    if (followSession.current === activeSessionId) return;
    followSession.current = activeSessionId;
    setFollowSpeech(true);
  }, [activeSessionId]);
  useEffect(() => { if (focusSegmentId) setFollowSpeech(false); }, [focusSegmentId]);
  // A finished jump forgets that it was dismissed, so citing the same fragment
  // again is a new jump rather than one already waved away.
  useEffect(() => { if (!focusSegmentId) setDismissedFocus(null); }, [focusSegmentId]);
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
      <div className="transcript" ref={scrollRef} tabIndex={cleanNative ? 0 : undefined}
        onWheel={event => scrollAcrossPart(event.deltaY)}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          if (['ArrowUp', 'PageUp'].includes(event.key)) scrollAcrossPart(-1);
          else if (['ArrowDown', 'PageDown'].includes(event.key)) scrollAcrossPart(1);
        }}
        onTouchStart={event => { touchY.current = event.touches[0]?.clientY ?? null; }}
        onTouchMove={event => {
          const next = event.touches[0]?.clientY;
          if (touchY.current !== null && next !== undefined) scrollAcrossPart(touchY.current - next);
          touchY.current = next ?? null;
        }} onScroll={(event) => {
        if (!cleanNative) return;
        const element = event.currentTarget;
        if (Date.now() < navigationUntil.current) return;
        setFollowSpeech(!native.hasNewer && element.scrollHeight - element.clientHeight - element.scrollTop < 48);
      }}>

        {opening ? (
          showLoader ? <div className="panel__center"><TranscriptLoading /></div> : null
        ) : error ? (
          <div className="panel__center">
            <EmptyState icon="warning" title="Couldn’t load the transcript" hint={error} />
          </div>
        ) : cleanNative && native.snapshot && hasWords(native.snapshot) ? (
          <NativeMonologues key={`${native.snapshot.session_id}:${native.part?.id ?? 'live'}`} snapshot={native.snapshot} segments={segments} videoId={videoId} focusSegmentId={dismissedFocus === focusSegmentId ? null : focusSegmentId} />
        ) : !contextual && capturing && segments.length === 0 ? (
          <WaitingForWords snapshot={native.snapshot} />
        ) : segments.length === 0 && (!contextual || (!hasDraftText && fragments.length === 0)) ? (
          <div className="panel__center">
            {contextual && live ? (
              <EmptyState
                icon="transcript"
                title="Listening…"
                hint="Words appear here moments after they are spoken."
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
                    )}
                    ref={(element) => {
                      if (element) rowRefs.current.set(item.segment.id, element);
                      else rowRefs.current.delete(item.segment.id);
                    }}
                  >
                    <span className="transcript__source-link tabular">
                      {formatTimecode(item.segment.start_ms)}
                    </span>{' '}
                    {item.segment.text}{' '}
                  </span>
                ))}
                {hasDraftText && draft && draft.text_scope !== 'whole_window' && (
                  <span className="transcript__draft-inline" aria-label="Revisable transcript draft">
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
                )}
                ref={(el) => {
                  if (el) rowRefs.current.set(item.segment.id, el);
                  else rowRefs.current.delete(item.segment.id);
                }}
              >
                <div className="segment__audio-actions">
                  <span className="segment__time tabular">{mediaSourceLink(videoId, item.segment.start_ms) ? <a href={mediaSourceLink(videoId, item.segment.start_ms)!} target="_blank" rel="noreferrer">{formatTimecode(item.segment.start_ms)}</a> : formatTimecode(item.segment.start_ms)}</span>
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
        {contextual && liveError && <p className="transcript__error" role="alert">{liveError}</p>}
        {live && contextual && <LiveQueueStatus />}
      </div>
      {cleanNative && !followSpeech && <button type="button" className="transcript__follow" onClick={() => {
        if (native.windowed) native.latest();
        setDismissedFocus(focusSegmentId);
        setFollowSpeech(true);
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }}>
        {live && <span className="transcript__follow-live" aria-hidden="true" />}
        <Icon name="arrow-down" size={15} />
        <span>Jump to live</span>
      </button>}
    </div>
  );
}
