import { useEffect, useMemo, useState } from 'react';
import type { KbMaterialSummary } from '../../api/kb/types.gen';
import type { KbWikiState } from '../api/names';
import { Banner, Button, EmptyState, Icon, IconButton, Segmented, Spinner } from '../ui';
import { KIND_ICON, KIND_LABEL } from '../library/materialMeta';
import { useFolderTone } from '../document/parts';
import { errorText } from '../api/client';
import { useInterval, useLoad } from '../document/useLoad';
import { useLibrary, useServices, useUi } from '../state/context';
import { SelectAllBox, SelectionCheckbox } from '../ui/listSelection';
import { useMaterialSelection } from './materialBatch';

type TypeFilter = 'all' | 'recordings' | 'documents' | 'links' | 'text';
type Sort = 'newest' | 'oldest' | 'name';
type Layout = 'table' | 'cards';

const TYPE_KINDS: Record<Exclude<TypeFilter, 'all'>, ReadonlyArray<KbMaterialSummary['kind']>> = {
  recordings: ['recording', 'audio', 'video', 'video_link'],
  documents: ['pdf', 'book'],
  links: ['web'],
  text: ['text'],
};

const TYPE_OPTIONS: ReadonlyArray<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'recordings', label: 'Recordings' },
  { value: 'documents', label: 'Documents' },
  { value: 'links', label: 'Links' },
  { value: 'text', label: 'Text' },
];

/** "Today", "yesterday", else "11 Oct". */
export function addedLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Wiki column (decision 25): processing state honestly, no invented counts. */
export function WikiCell({ material }: { material: KbMaterialSummary }) {
  type Shown = KbWikiState | 'reading' | 'unknown';
  // A package-1 backend has no wiki_state: show a dash, not a guess.
  const known = material.wiki_state as KbWikiState | undefined;
  const state: Shown = material.status === 'processing' || material.status === 'recording'
    ? 'reading' : material.status === 'failed' ? 'failed' : known ?? 'unknown';
  const view: Record<Shown, { icon: 'check' | 'close' | 'warning' | null; text: string; tone: string }> = {
    in_wiki: { icon: 'check', text: 'In wiki', tone: 'ok' },
    queued: { icon: null, text: 'Queued', tone: 'run' },
    processing: { icon: null, text: 'Adding…', tone: 'run' },
    reading: { icon: null, text: material.status === 'recording' ? 'Recording…' : 'Processing…', tone: 'run' },
    not_in_wiki: { icon: 'close', text: 'Not in wiki', tone: 'off' },
    failed: { icon: 'warning', text: 'Error', tone: 'err' },
    // C1-d: stopped at the material's wiki budget; Continue is on the material.
    paused: { icon: 'warning', text: 'Paused', tone: 'off' },
    unknown: { icon: null, text: '—', tone: 'off' },
  };
  const v = view[state];
  return (
    <span className={`kb-wk kb-wk--${v.tone}`} title={v.text}>
      <span className="kb-stx" aria-hidden="true">
        {v.icon ? <Icon name={v.icon} size={11} /> : v.tone === 'run' ? <span className="kb-spinner kb-spinner--xs" /> : null}
      </span>
      <span className="kb-wk__text">{v.text}</span>
    </span>
  );
}

/** "All materials" over the centre (v11, decision 25): table by default, cards on demand. */
export function AllMaterials({ hidden }: { hidden: boolean }) {
  const { client } = useServices();
  const folders = useLibrary((s) => s.folders);
  const libraryCount = useLibrary((s) => s.materials.length);
  const revision = useLibrary((s) => s.revision);
  const showCenter = useUi((s) => s.showCenter);
  const openDocument = useUi((s) => s.openDocument);
  const openedId = useUi((s) => s.docMaterialId);
  const setAddOpen = useUi((s) => s.setAddMaterialOpen);
  const tone = useFolderTone();
  const [type, setType] = useState<TypeFilter>('all');
  const [folderId, setFolderId] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [layout, setLayout] = useState<Layout>('table');
  const { state, reload } = useLoad('all', async () => client.call('GET /kb/materials'));
  // The library list changed (added, recorded, deleted, renamed): read again, keeping the table on screen.
  useEffect(() => { reload(); }, [revision, reload]);
  const gone = useLibrary((s) => s.gone);
  const all = useMemo(() => (state.value ?? []).filter((m) => !gone.includes(m.id)), [state.value, gone]);
  const busy = all.some((m) => m.status === 'processing' || m.status === 'recording'
    || m.wiki_state === 'processing' || m.wiki_state === 'queued');
  useInterval(busy && !hidden, 3000, reload);
  const failedCount = all.filter((m) => m.wiki_state === 'failed' && m.status !== 'failed').length;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  /** H2: every material whose wiki job failed or was interrupted goes back in the queue, in one click. */
  const retryFailed = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await client.call('POST /kb/jobs/retry-failed');
      reload();
    } catch (error) {
      setRetryError(errorText(error));
    } finally {
      setRetrying(false);
    }
  };

  const rows = useMemo(() => {
    const kinds = type === 'all' ? null : TYPE_KINDS[type];
    const out = all.filter((m) => (!kinds || kinds.includes(m.kind)) && (!folderId || m.folder_id === folderId));
    out.sort((a, b) => (sort === 'name' ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      : sort === 'oldest' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
    return out;
  }, [all, type, folderId, sort]);
  const tableRows = layout === 'table' ? rows : [];
  const { sel, overlays, dragProps } = useMaterialSelection({
    rows: tableRows, resetKey: `${type}|${folderId}|${layout}`, variant: 'full',
    onOpen: (id) => openDocument({ type: 'material', id }),
  });
  const selectable = tableRows.filter((m) => !sel.reasonOf(m.id)).length;
  const allState = sel.selected.size === 0 ? 'none' : sel.selected.size >= selectable ? 'all' : 'some';
  const folderName = (m: KbMaterialSummary) => m.folder_name || folders.find((f) => f.id === m.folder_id)?.name || '';

  return (
    <section className="kb-center kb-allmat" data-pane="materials" aria-label="All materials" hidden={hidden}>
      <header className="kb-head">
        <h1 className="kb-head__title kb-allmat__title">All materials</h1>
        <span className="kb-muted kb-allmat__count">{all.length || libraryCount}</span>
        <span className="kb-head__spacer" />
        {failedCount > 0 && (
          <Button size="sm" icon="retry" busy={retrying} onClick={() => void retryFailed()}
            title={retryError ?? 'Add the materials that failed to the wiki again'}>
            Retry failed ({failedCount})
          </Button>
        )}
        <Button size="sm" variant="fill" icon="plus" onClick={() => setAddOpen(true)}>Add</Button>
        <IconButton icon="close" label="Close all materials" onClick={() => showCenter('chat')} />
      </header>
      <div className="kb-allmat__body" {...sel.listProps}>
        <div className="kb-amf">
          <Segmented label="Type" size="sm" value={type} options={TYPE_OPTIONS} onChange={setType} />
          <span className="kb-head__spacer" />
          <label className="kb-select kb-select--sm">
            <span className="kb-visually-hidden">Folder</span>
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="Folder">
              <option value="">Folder: all</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <Icon name="chevronDown" size={12} className="kb-select__chev" />
          </label>
          <label className="kb-select kb-select--sm">
            <span className="kb-visually-hidden">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">By name</option>
            </select>
            <Icon name="chevronDown" size={12} className="kb-select__chev" />
          </label>
          <Segmented label="View" size="sm" value={layout} onChange={setLayout} options={[
            { value: 'table', label: <Icon name="table" size={14} />, name: 'Table' },
            { value: 'cards', label: <Icon name="cards" size={14} />, name: 'Cards' },
          ]} />
        </div>
        {state.load === 'loading' && !state.value && <div className="kb-doc__wait"><Spinner label="Loading materials" /></div>}
        {state.load === 'error' && (
          <Banner tone="error" title="Couldn’t load materials." actions={<Button size="sm" icon="retry" onClick={reload}>Try again</Button>}>{state.error}</Banner>
        )}
        {state.value && rows.length === 0 && (
          <EmptyState icon="materials" title={all.length ? 'Nothing matches these filters' : 'No materials yet'}
            action={all.length ? undefined : <Button size="sm" variant="fill" icon="plus" onClick={() => setAddOpen(true)}>Add material</Button>}>
            {all.length ? 'Choose another type or folder.' : 'Record, drop files or paste a link — everything lands here.'}
          </EmptyState>
        )}
        {rows.length > 0 && layout === 'table' && (
          <table className="kb-amt" {...sel.gridProps} aria-label="Materials">
            <colgroup>
              <col className="kb-amt__c-sel" /><col className="kb-amt__c-type" /><col className="kb-amt__c-name" /><col className="kb-amt__c-folder" />
              <col className="kb-amt__c-added" /><col className="kb-amt__c-wiki" />
            </colgroup>
            <thead>
              <tr><th className="kb-amt__sel"><SelectAllBox state={allState} onChange={(all) => (all ? sel.selectAll() : sel.clear())} /></th><th aria-label="Type" /><th>Name</th><th className="kb-amt__folder-col">Folder</th><th className="kb-amt__added">Added</th><th>Wiki</th></tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={openedId === m.id ? 'is-current' : undefined} {...sel.rowProps(m.id)} {...dragProps(m)}
                  onClick={() => openDocument({ type: 'material', id: m.id })}>
                  {/* Own column, as in mockup lib-v1: the box never shares a cell with the type icon. */}
                  <td className="kb-amt__sel"><SelectionCheckbox checked={sel.selected.has(m.id)} reason={sel.reasonOf(m.id)} /></td>
                  <td className="kb-amt__type">
                    <Icon name={KIND_ICON[m.kind]} size={15} label={KIND_LABEL[m.kind]} />
                  </td>
                  <td className="kb-amt__name">
                    <button type="button" className="kb-amt__open" onClick={(e) => { e.stopPropagation(); openDocument({ type: 'material', id: m.id }); }}>
                      {m.title}
                    </button>
                  </td>
                  <td className="kb-amt__folder-col"><span className="kb-amt__folder"><span className="kb-fdot" style={{ background: tone(m.folder_id) ?? 'var(--kb-line)' }} aria-hidden="true" /><span className="kb-amt__cell">{folderName(m)}</span></span></td>
                  <td className="kb-amt__added kb-muted"><span className="kb-amt__cell">{addedLabel(m.created_at)}</span></td>
                  <td><WikiCell material={m} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {overlays}
        {rows.length > 0 && layout === 'cards' && (
          <ul className="kb-amg" aria-label="Materials">
            {rows.map((m) => (
              <li key={m.id}>
                <button type="button" className={`kb-amc${openedId === m.id ? ' is-current' : ''}`} onClick={() => openDocument({ type: 'material', id: m.id })}>
                  <span className="kb-amc__top"><Icon name={KIND_ICON[m.kind]} size={16} label={KIND_LABEL[m.kind]} /><span className="kb-head__spacer" /><WikiCell material={m} /></span>
                  <span className="kb-amc__title">{m.title}</span>
                  <span className="kb-amc__meta"><span className="kb-fdot" style={{ background: tone(m.folder_id) ?? 'var(--kb-line)' }} aria-hidden="true" />{folderName(m)}</span>
                  <span className="kb-amc__meta kb-muted">{addedLabel(m.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
