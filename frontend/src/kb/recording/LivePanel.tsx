import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { normalizeMaterial, type KbMaterial } from '../api/b2-u3';
import { Button, Icon, Spinner } from '../ui';
import { formatTime } from '../library/materialMeta';
import { PanelFrameButtons } from '../document/parts';
import { useInterval, useLoad } from '../document/useLoad';
import { useLibrary, useRecording, useServices } from '../state/context';
import { languageName } from '../material/MaterialView';
import { Transcript } from '../material/Transcript';
import { isLive } from './recordingStore';

interface TailPage {
  tail: { originals: Array<{ text: string }>; translations: Array<{ text: string }> } | null;
}

const NEAR_BOTTOM = 80;

/** Live transcript on the right while recording (v12–v15): text grows, unstable tail in grey. */
export function LivePanel({ materialId }: { materialId: string }) {
  const { u3, bridge } = useServices();
  const folders = useLibrary((s) => s.folders);
  const phase = useRecording((s) => s.phase);
  const recMaterial = useRecording((s) => s.materialId);
  const sessionId = useRecording((s) => s.sessionId);
  const view = useRecording((s) => s.view);
  const failure = useRecording((s) => s.failure);
  const elapsed = useRecording((s) => s.elapsedMs);
  const { recording } = useServices();
  const mine = recMaterial === materialId;
  const live = mine && (isLive(phase) || phase === 'finishing' || phase === 'starting');
  const { state, reload } = useLoad<KbMaterial>(materialId, async () =>
    normalizeMaterial(await u3.call('GET /kb/materials/{material_id}', { path: { material_id: materialId } })));
  const [tail, setTail] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);

  useInterval(live, 1500, () => {
    reload();
    if (phase !== 'recording' || !sessionId) { setTail(''); return; }
    void bridge.request<TailPage>({ method: 'GET', path: `/sessions/${encodeURIComponent(sessionId)}/live/events`, query: { limit: 1 } })
      .then((res) => {
        if (!res.ok || !res.data.tail) { setTail(''); return; }
        const parts = view === 'translation' && res.data.tail.translations.length ? res.data.tail.translations : res.data.tail.originals;
        setTail(parts.map((t) => t.text).join('').trim());
      }, () => setTail(''));
  });
  useEffect(() => { if (!live) setTail(''); }, [live]);

  const material = state.value;
  const count = material?.fragments.length ?? 0;
  // Follow the newest text unless the user scrolled back.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [count, tail, following]);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM);
  };

  const failed = failure && failure.materialId === materialId ? failure : null;
  const status = !mine ? null
    : phase === 'recording' ? <span className="kb-live__status">Recording</span>
      : phase === 'paused' || phase === 'pausing' ? <span className="kb-live__status"><span className="kb-pzd" aria-hidden="true" />Paused</span>
        : phase === 'finishing' ? <span className="kb-live__status"><Spinner label="Finishing" size="sm" />Finishing…</span>
          : phase === 'starting' || phase === 'resuming' ? <span className="kb-live__status"><Spinner label="Starting" size="sm" />Starting…</span>
            : failed ? <span className="kb-live__status kb-live__status--error"><Icon name="warning" size={14} />Stopped</span>
              : null;
  const folderName = material ? folders.find((f) => f.id === material.folder_id)?.name : undefined;
  const meta = material ? [folderName, material.languages.map(languageName).join(', ')
    + (material.translation ? ` → ${languageName(material.translation.language)}` : '')].filter(Boolean).join(' · ') : '';

  return (
    <>
      <header className="kb-head kb-head--doc">
        {status ?? <span className="kb-live__status">Recording</span>}
        <span className="kb-head__spacer" />
        <PanelFrameButtons closeLabel="Close live transcript" />
      </header>
      <div className="kb-doc__body kb-live" ref={bodyRef} onScroll={onScroll} aria-live="off">
        {!material && state.load !== 'error' && <div className="kb-doc__wait"><Spinner label="Opening the recording" /></div>}
        {material && (
          <article className="kb-doc__article">
            <h2 className="kb-doc__title kb-doc__title--sm">{material.title}</h2>
            {meta && <p className="kb-doc__meta">{meta}</p>}
            {failed && (
              <div className="kb-lerr" role="alert">
                <Icon name="warning" size={16} />
                <div>
                  <p><b>Recognition stopped at {formatTime(failed.atMs)}.</b></p>
                  <p className="kb-muted">{failed.message} The text up to {formatTime(failed.atMs)} is saved. Recording won’t continue by itself.</p>
                  <div className="kb-lerr__actions">
                    <Button size="sm" variant="fill" icon="mic" onClick={() => void recording.getState().continueAfterFailure()}>Continue recording</Button>
                  </div>
                </div>
              </div>
            )}
            {count === 0 && !tail && (
              <p className="kb-muted">{live ? `Listening… ${elapsed > 0 ? formatTime(elapsed) : ''}` : 'No text was recognised.'}</p>
            )}
            {(count > 0 || tail) && (
              <Transcript material={material} corrections={[]} view={material.translation ? view : 'original'} sideBySide={false}
                target={{ seg: null, quote: null }} onCorrectionChanged={() => undefined} tail={tail || undefined} />
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
