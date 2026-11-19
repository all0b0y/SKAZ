import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KbFragment, KbMaterial, KbRecordingLive } from '../../api/kb/types.gen';
import { Banner, Button, Icon, Spinner } from '../ui';
import { formatTime } from '../library/materialMeta';
import { ReaderPanelHeader } from '../document/readerSurface041/ReaderPanelHeader';
import { useLoad } from '../document/useLoad';
import { useLibrary, useRecording, useServices } from '../state/context';
import { languageName } from '../material/MaterialView';
import { Transcript } from '../material/Transcript';
import { isLive } from './recordingStore';
import { connectionText } from './connection';
import { StippleRing } from '../fx/stipple/StippleWork';
import { EMPTY_LIVE, lastSeg, liveAfter, type LiveText } from './liveText';

const NEAR_BOTTOM = 80;
const NO_FRAGMENTS: readonly KbFragment[] = [];

function useFinalFragments(detail: KbMaterial | null, added: readonly KbFragment[]) {
  const retained = useRef(NO_FRAGMENTS);
  const pending = useMemo(() => {
    const covered = new Set(detail?.fragments.map(({ seg }) => seg));
    const bySegment = new Map<number, KbFragment>();
    for (const fragment of [...retained.current, ...added]) {
      if (!covered.has(fragment.seg)) bySegment.set(fragment.seg, fragment);
    }
    return [...bySegment.values()];
  }, [detail, added]);
  useLayoutEffect(() => { retained.current = pending; }, [pending]);
  const material = useMemo(() => {
    if (!detail || pending.length === 0) return detail;
    return { ...detail, fragments: [...detail.fragments, ...pending].sort((a, b) => a.seg - b.seg) };
  }, [detail, pending]);
  return { material, uncovered: pending.length !== 0 };
}

/**
 * Live transcript on the right while recording (v12–v15): closed monologues from the material, then
 * the open monologue's final words as they are recognised (stable), then the words still being
 * recognised (grey, replaced in place). It follows the end unless the reader scrolled back.
 */
export function LivePanel({ materialId }: { materialId: string }) {
  const sessionId = useRecording((s) => s.materialId === materialId ? s.sessionId : null);
  const [scope, setScope] = useState({ materialId, sessionId });
  // Keep the old material readable if another recording starts while its panel is still open.
  // A new session for the same material starts with a fresh view and invalidates previous reads.
  const changed = scope.materialId !== materialId || (sessionId !== null && scope.sessionId !== sessionId);
  const current = changed ? { materialId, sessionId } : scope;
  if (changed) setScope(current);
  return <LiveTranscript key={JSON.stringify([current.materialId, current.sessionId])} {...current} />;
}

function LiveTranscript({ materialId, sessionId }: { materialId: string; sessionId: string | null }) {
  const { client, recording } = useServices();
  const folders = useLibrary((s) => s.folders);
  const phase = useRecording((s) => s.phase);
  const mine = useRecording((s) => s.materialId === materialId && s.sessionId === sessionId);
  const view = useRecording((s) => s.view);
  const failure = useRecording((s) => s.failure);
  const elapsed = useRecording((s) => s.elapsedMs);
  const stream = useRecording((s) => s.stream);
  const provider = useRecording((s) => s.provider);
  const liveAnswer = useRecording((s) =>
    s.materialId === materialId && s.sessionId === sessionId && s.live?.material_id === materialId ? s.live : null);
  const liveFragments = useRecording((s) =>
    s.materialId === materialId && s.sessionId === sessionId && s.live?.material_id === materialId ? s.liveFragments : NO_FRAGMENTS);
  const live = mine && (isLive(phase) || phase === 'finishing' || phase === 'starting');
  const { state, reload } = useLoad<KbMaterial>(materialId, async () => {
    const detail = await client.call('GET /kb/materials/{material_id}', { path: { material_id: materialId } });
    if (detail.id !== materialId) throw new Error('The recording response did not match this material.');
    return detail;
  });
  const initialReadFailed = state.load === 'error' && !state.value;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const reconnect = mine && phase === 'recording' ? connectionText(stream, provider) : null;

  const { material, uncovered } = useFinalFragments(state.value, liveFragments);
  const count = material?.fragments.length ?? 0;
  const seg = material ? lastSeg(material.fragments) : 0;
  // Speech after the fragments: the open monologue's final words as they arrive, then the words
  // still being recognised. When the material is a step behind the live answer, keep the text that
  // fits it until it is reloaded — the monologue that just closed never blinks out or shows twice.
  const shown = useRef<{ seg: number; text: LiveText }>({ seg: 0, text: EMPTY_LIVE });
  const fitted = liveAnswer && material ? liveAfter(liveAnswer, seg) : EMPTY_LIVE;
  const behind = fitted === 'material-behind';
  const liveText = !behind ? fitted : shown.current.seg === seg ? shown.current.text : EMPTY_LIVE;
  useLayoutEffect(() => { shown.current = { seg, text: liveText }; }, [seg, liveText]);

  // Stop, catch-up and explicit Retry share one read. A failed initial read waits for Retry.
  const lastReload = useRef<typeof state | null>(null);
  const read = useCallback(() => {
    if (state.load === 'loading' || lastReload.current === state) return;
    lastReload.current = state;
    reload();
  }, [state, reload]);
  const wasLive = useRef(live);
  const caughtUpFor = useRef<KbRecordingLive | null>(null);
  useEffect(() => {
    const stopped = wasLive.current && !live && mine;
    wasLive.current = live;
    const catchUp = live && behind && caughtUpFor.current !== liveAnswer;
    if (catchUp) caughtUpFor.current = liveAnswer;
    if ((stopped || catchUp) && !initialReadFailed) read();
  }, [behind, initialReadFailed, live, liveAnswer, mine, read]);
  const needsFinalRead = !live && (uncovered || behind || liveText.monologues.length > 0);
  const partial = live && liveText.partial
    ? (view === 'translation' && liveText.partial.translation ? liveText.partial.translation : liveText.partial.text) : '';
  const extra = { monologues: liveText.monologues, partial: partial ? { speaker: liveText.partial!.speaker, text: partial } : null };
  const growth = liveText.monologues.reduce((n, m) => n + m.text.length, 0) + partial.length;

  // Follow the newest text unless the user scrolled back.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [count, growth, following]);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM);
  };

  const failed = mine && phase === 'idle' && failure?.materialId === materialId ? failure : null;
  const continueRecording = () => {
    const current = recording.getState();
    if (current.materialId === materialId && current.sessionId === sessionId
      && current.failure?.materialId === materialId && current.phase === 'idle') {
      void current.continueAfterFailure();
    }
  };
  const status = !mine ? null
    : reconnect ? <span className="kb-live__status kb-live__status--warn" role="status"><StippleRing className="kb-spinner kb-spinner--inline" />{reconnect.short}</span>
    : phase === 'recording' ? <span className="kb-live__status">Recording</span>
      : phase === 'paused' || phase === 'pausing' ? <span className="kb-live__status"><span className="kb-pzd" aria-hidden="true" />Paused</span>
        : phase === 'finishing' ? <span className="kb-live__status"><Spinner label="Finishing" size="sm" />Finishing…</span>
          : phase === 'starting' || phase === 'resuming' ? <span className="kb-live__status"><Spinner label="Starting" size="sm" />Starting…</span>
            : failed ? <span className="kb-live__status kb-live__status--error"><Icon name="warning" size={14} />Stopped</span>
              : null;
  const folderName = material ? folders.find((f) => f.id === material.folder_id)?.name : undefined;
  const meta = material ? [folderName, material.languages.map(languageName).join(', ')
    + (material.translation?.language ? ` → ${languageName(material.translation.language)}` : '')].filter(Boolean).join(' · ') : '';

  return (
    <>
      <ReaderPanelHeader typeLabel="Recording" typeStatus={status ?? <span className="kb-live__status">Recording</span>}
        closeLabel="Close live transcript" />
      <div className="kb-doc__body kb-live" ref={bodyRef} onScroll={onScroll} aria-live="off">
        {!material && state.load !== 'error' && <div className="kb-doc__wait"><Spinner label="Opening the recording" /></div>}
        {(material || initialReadFailed || failed) && (
          <article className="kb-doc__article">
            {material && <h2 className="kb-doc__title kb-doc__title--sm">{material.title}</h2>}
            {meta && <p className="kb-doc__meta">{meta}</p>}
            {material && reconnect?.long && (
              <p className="kb-live__note" role="note"><Icon name="warning" size={14} />{reconnect.long}</p>
            )}
            {initialReadFailed && (
              <Banner tone="error" title="Couldn’t open this recording."
                actions={<Button size="sm" icon="retry" onClick={read}>Try again</Button>}>
                {state.error}
              </Banner>
            )}
            {material && needsFinalRead && (
              <Banner tone={state.load === 'error' ? 'error' : state.load === 'loading' ? 'progress' : 'warning'}
                title={state.load === 'error' ? 'Couldn’t refresh the final transcript.'
                  : state.load === 'loading' ? 'Reading the final transcript…' : 'The final transcript is still catching up.'}
                actions={<Button size="sm" icon="retry" aria-disabled={state.load === 'loading'} onClick={read}>Try again</Button>}>
                {state.load === 'error' ? state.error : null}
              </Banner>
            )}
            {failed && (
              <div className="kb-lerr" role="alert">
                <Icon name="warning" size={16} />
                <div>
                  <p><b>Recognition stopped at {formatTime(failed.atMs)}.</b></p>
                  <p className="kb-muted">{failed.message}{material && !needsFinalRead && ` The text up to ${formatTime(failed.atMs)} is saved.`} Recording won’t continue by itself.</p>
                  <div className="kb-lerr__actions">
                    <Button size="sm" variant="fill" icon="mic" onClick={continueRecording}>Continue recording</Button>
                  </div>
                </div>
              </div>
            )}
            {material && count === 0 && !growth && (
              <p className="kb-muted">{live ? `Listening… ${elapsed > 0 ? formatTime(elapsed) : ''}` : 'No text was recognised.'}</p>
            )}
            {material && (count > 0 || growth > 0) && (
              <Transcript material={material} corrections={[]} view={material.translation ? view : 'original'} sideBySide={false}
                target={{ seg: null, quote: null }} onCorrectionChanged={() => undefined} live={extra} />
            )}
          </article>
        )}
        {live && !following && (
          <button type="button" className="kb-follow" onClick={() => { setFollowing(true); const el = bodyRef.current; if (el) el.scrollTop = el.scrollHeight; }}>
            <Icon name="chevronDown" size={13} />To current
          </button>
        )}
      </div>
    </>
  );
}
