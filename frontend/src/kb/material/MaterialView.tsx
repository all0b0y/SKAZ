import { useEffect, useRef, useState } from 'react';
import type { KbCorrection, KbCorrectionChange, KbJob, KbMaterial } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Banner, Button, Icon, IconButton, Menu, Segmented, Spinner } from '../ui';
import { KIND_ICON, KIND_LABEL, formatTime } from '../library/materialMeta';
import { PanelFrameButtons, useAskAbout } from '../document/parts';
import { useInterval, useLoad } from '../document/useLoad';
import { useScrollTarget } from '../document/useScrollTarget';
import { useLibrary, useRecording, useServices, useUi } from '../state/context';
import type { DocTarget } from '../state/document';
import { ExcludedFragments } from './ExcludedFragments';
import { DeleteDialog, MoveDialog, RenameDialog, type MaterialDialog } from './MaterialDialogs';
import { StatusChips } from './StatusChips';
import { changeNote, Transcript, type TranscriptView } from './Transcript';

const SPEECH = new Set<KbMaterial['kind']>(['recording', 'audio', 'video', 'video_link']);

interface MaterialData {
  material: KbMaterial;
  corrections: KbCorrection[];
  jobs: KbJob[];
}

const LANG: Record<string, string> = {
  en: 'English', ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  uk: 'Ukrainian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', tr: 'Turkish', pl: 'Polish',
};
export const languageName = (code: string) => LANG[code] ?? code.toUpperCase();

function durationOf(material: KbMaterial): number | null {
  const ends = material.fragments.map((f) => f.end_ms ?? f.start_ms).filter((v): v is number => v !== null);
  return ends.length ? Math.max(...ends) : null;
}

function metaLine(material: KbMaterial, folderName: string | undefined): string {
  const parts: string[] = [];
  if (folderName) parts.push(folderName);
  if (SPEECH.has(material.kind)) {
    const d = durationOf(material);
    if (d !== null) parts.push(formatTime(d));
  } else if (material.kind === 'pdf' || material.kind === 'book') {
    const pages = new Set(material.fragments.map((f) => f.page).filter((p) => p !== null));
    if (pages.size) parts.push(`${pages.size} ${pages.size === 1 ? 'page' : 'pages'}`);
  } else if (material.origin?.url) {
    try { parts.push(new URL(material.origin.url).hostname.replace(/^www\./, '')); } catch { /* not a URL */ }
  }
  parts.push(new Date(material.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
  const lang = material.languages.map(languageName).join(', ');
  if (lang) parts.push(material.translation?.language ? `${lang} → ${languageName(material.translation.language)}` : lang);
  return parts.join(' · ');
}

/** Material + its corrections and jobs; polled while anything about it is still running. */
export function useMaterialData(materialId: string) {
  const { client } = useServices();
  const loader = useLoad<MaterialData>(materialId, async () => {
    const material = await client.call('GET /kb/materials/{material_id}', { path: { material_id: materialId } });
    const [corrections, jobs] = await Promise.all([
      SPEECH.has(material.kind)
        ? client.call('GET /kb/materials/{material_id}/corrections', { path: { material_id: materialId } }).catch(() => [])
        : Promise.resolve([]),
      client.call('GET /kb/jobs', { query: { material_id: materialId } }).catch(() => []),
    ]);
    return { material, corrections, jobs };
  });
  const data = loader.state.value;
  const busy = data !== null && (data.material.status === 'processing' || data.material.status === 'recording'
    || data.material.wiki?.state === 'processing' || data.jobs.some((j) => j.state === 'running'));
  useInterval(busy && loader.state.load !== 'loading', 2000, loader.reload);
  return loader;
}

/**
 * A recording SKAZ made and that is paused or stopped may continue into the same material and
 * session (the old "Continue recording", also after a restart). The backend's carrier decides:
 * a recording without one (seeded, imported) never offers it.
 */
function useContinuable(material: KbMaterial | null): boolean {
  const { client } = useServices();
  const phase = useRecording((s) => s.phase);
  const id = material?.kind === 'recording' && material.status !== 'recording' && material.status !== 'processing' ? material.id : null;
  const [state, setState] = useState<{ id: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!id || phase !== 'idle') return undefined;
    let live = true;
    client.call('GET /kb/recordings/{material_id}', { path: { material_id: id } }).then(
      (view) => { if (live) setState({ id, ok: view.recording_state === 'paused' || view.recording_state === 'stopped' }); },
      () => { if (live) setState({ id, ok: false }); },
    );
    return () => { live = false; };
  }, [client, id, phase]);
  return id !== null && phase === 'idle' && state?.id === id && state.ok;
}

/** Material in the right panel (v10, decision 24). */
export function MaterialView({ target, nonce }: { target: DocTarget; nonce: number }) {
  const { client, recording } = useServices();
  const askAbout = useAskAbout();
  const folders = useLibrary((s) => s.folders);
  const expanded = useUi((s) => s.docExpanded);
  const { state, reload, set } = useMaterialData(target.id);
  const data = state.value;
  const material = data?.material ?? null;
  const continuable = useContinuable(material);
  const [view, setView] = useState<TranscriptView>('original');
  const [dialog, setDialog] = useState<MaterialDialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const hasTranslation = Boolean(material?.translation && material.translation.fragments.length > 0);

  // Decision 24: translation by default when the recording was made with one.
  useEffect(() => { setView('original'); setNote(null); }, [target.id]);
  useEffect(() => { if (hasTranslation && !target.seg) setView('translation'); }, [hasTranslation, target.id, target.seg]);
  // A citation is checked against the original words: show them when we jump to a quote.
  useEffect(() => { if (target.seg) setView('original'); }, [target.seg, nonce]);
  useScrollTarget(bodyRef.current, target.seg ? `seg-${target.seg}` : null, nonce, state.load === 'ready' || data !== null);

  const onCorrection = (change: KbCorrectionChange) => {
    setNote(changeNote(change));
    reload();
  };
  const addToWiki = async () => {
    if (!material) return;
    setAdding(true);
    setAddError(null);
    try {
      await client.call('POST /kb/materials/{material_id}/ingest', { path: { material_id: material.id } });
      reload();
    } catch (e) {
      setAddError(errorText(e));
    } finally {
      setAdding(false);
    }
  };
  const replace = (next: KbMaterial) => { if (data) set({ ...data, material: next }); };
  const folderName = material ? folders.find((f) => f.id === material.folder_id)?.name : undefined;
  const viewOptions = [
    { value: 'original' as const, label: 'Original' },
    { value: 'translation' as const, label: 'Translation' },
    { value: 'both' as const, label: expanded ? 'Side by side' : 'Both', name: 'Both' },
  ];

  return (
    <>
      <header className="kb-head kb-head--doc">
        <span className="kb-doc__type">
          {material && <Icon name={KIND_ICON[material.kind]} size={14} />}
          <span>{material ? KIND_LABEL[material.kind] : 'Material'}</span>
        </span>
        <span className="kb-head__spacer" />
        <PanelFrameButtons
          more={(
            <>
              <IconButton ref={moreRef} icon="more" label="Material actions" aria-haspopup="menu" aria-expanded={menuOpen}
                disabled={!material} onClick={() => setMenuOpen((v) => !v)} />
              <Menu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={moreRef} label="Material actions" items={[
                { id: 'move', label: 'Move to folder', icon: 'folder', onSelect: () => setDialog('move') },
                { id: 'rename', label: 'Rename', icon: 'pencil', onSelect: () => setDialog('rename') },
                {
                  id: 'delete', label: 'Delete…', icon: 'trash', danger: true,
                  disabled: material?.status === 'recording', note: material?.status === 'recording' ? 'Recording' : undefined,
                  onSelect: () => setDialog('delete'),
                },
              ]} />
            </>
          )}
        >
          <IconButton icon="chats" label="Ask about material" disabled={!material}
            onClick={() => material && askAbout({ type: 'material', id: material.id, title: material.title })} />
          <IconButton icon="folder" label="Move to folder" disabled={!material} onClick={() => setDialog('move')} />
        </PanelFrameButtons>
      </header>
      <div className="kb-doc__body" ref={bodyRef}>
        {state.load === 'loading' && !data && <div className="kb-doc__wait"><Spinner label="Opening the material" /></div>}
        {state.load === 'error' && !data && (
          <Banner tone="error" title="Couldn’t open this material."
            actions={<Button size="sm" icon="retry" onClick={reload}>Try again</Button>}>{state.error}</Banner>
        )}
        {material && data && (
          <article className={`kb-doc__article kb-mat${expanded ? ' is-wide' : ''}`} data-material-kind={material.kind}>
            <h2 className="kb-doc__title">{material.title}</h2>
            <p className="kb-doc__meta">{metaLine(material, folderName)}</p>
            <StatusChips material={material} jobs={data.jobs} onAddToWiki={() => void addToWiki()} adding={adding} />
            {continuable && (
              <div className="kb-mat__actions">
                <Button size="sm" variant="outline" icon="mic" onClick={() => void recording.getState().continueRecording(material.id)}>
                  Continue recording
                </Button>
              </div>
            )}
            {addError && <p className="kb-inline-error" role="alert">{addError}</p>}
            {note && <p className="kb-mat__note" role="status">{note}</p>}
            <ExcludedFragments materialId={material.id} count={material.excluded_count} onRestored={reload} />
            {hasTranslation && (
              <Segmented label="Show" size="sm" value={view} options={viewOptions} onChange={setView} />
            )}
            {material.fragments.length === 0 ? (
              <p className="kb-muted">{material.status === 'ready' ? 'This material has no text.' : 'The text appears here as soon as it is ready.'}</p>
            ) : (
              <Transcript material={material} corrections={data.corrections} view={hasTranslation ? view : 'original'}
                sideBySide={expanded} target={{ seg: target.seg ?? null, quote: target.quote ?? null }}
                onCorrectionChanged={onCorrection} />
            )}
            {material.kind === 'web' && material.origin?.url && (
              <p className="kb-arturl">
                <Icon name="link" size={14} />
                <span className="kb-arturl__t">{material.origin.url}</span>
                <a className="kb-link" href={material.origin.url} rel="noreferrer noopener"
                  onClick={(e) => { e.preventDefault(); window.open(material.origin!.url!, '_blank', 'noopener'); }}>
                  Original ↗
                </a>
              </p>
            )}
          </article>
        )}
      </div>
      {material && (
        <>
          <RenameDialog material={material} open={dialog === 'rename'} onClose={() => setDialog(null)} onDone={replace} />
          <MoveDialog material={material} open={dialog === 'move'} onClose={() => setDialog(null)} onDone={replace} />
          <DeleteDialog material={material} open={dialog === 'delete'} onClose={() => setDialog(null)} />
        </>
      )}
    </>
  );
}
