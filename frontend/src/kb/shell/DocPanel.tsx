import { useEffect, useRef, useState } from 'react';
import type { KbMaterial, KbPage } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Banner, EmptyState, IconButton, Spinner } from '../ui';
import { Icon } from '../ui/Icon';
import { quoteAttrs } from '../ui/Selection';
import { useLibrary, useServices, useUi } from '../state/context';
import type { DocRef } from '../state/document';
import { KIND_ICON, KIND_LABEL, formatTime } from '../library/materialMeta';

type DocState =
  | { load: 'loading' }
  | { load: 'ready'; material: KbMaterial }
  | { load: 'page'; page: KbPage }
  | { load: 'error'; error: string };

const PAGE_LABEL: Record<KbPage['kind'], string> = { concept: 'Concept', note: 'Notes', folder: 'Folder overview', analysis: 'Analysis' };

/**
 * Right document panel: exists only while something is open (`openDocument`). ⤢ gives it the
 * centre, ✕ closes. A plain read-only view of a material's source text or a wiki page's blocks —
 * the full material and page screens are U3's; the opened fragment/block is scrolled to and marked.
 * Text here is quotable (selection → "Ask / Add to question / Copy").
 */
export function DocPanel({ doc, expanded, width }: { doc: DocRef; expanded: boolean; width: number }) {
  const { client } = useServices();
  const closeDoc = useUi((s) => s.closeDoc);
  const toggle = useUi((s) => s.toggleDocExpanded);
  const folders = useLibrary((s) => s.folders);
  const [state, setState] = useState<DocState>({ load: 'loading' });
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setState({ load: 'loading' });
    const request = doc.type === 'material'
      ? client.material(doc.id).then((material): DocState => ({ load: 'ready', material }))
      : client.call('GET /kb/wiki/pages/{page_id}', { path: { page_id: doc.id } }).then((page): DocState => ({ load: 'page', page }));
    request.then(
      (next) => { if (live) setState(next); },
      (error: unknown) => { if (live) setState({ load: 'error', error: errorText(error) }); },
    );
    return () => { live = false; };
  }, [client, doc.type, doc.id]);

  // Bring the cited fragment / block into view.
  useEffect(() => {
    const target = doc.seg != null ? `[data-seg="${doc.seg}"]` : doc.block_id ? `[data-block="${doc.block_id.replace(/["\\]/g, '')}"]` : null;
    if (!target) return;
    bodyRef.current?.querySelector(target)?.scrollIntoView?.({ block: 'center' });
  }, [state.load, doc.seg, doc.block_id]);

  const kind = state.load === 'ready' ? state.material.kind : null;
  const folder = state.load === 'ready' ? folders.find((f) => f.id === state.material.folder_id)?.name : undefined;
  const typeLabel = state.load === 'page' ? PAGE_LABEL[state.page.kind] : kind ? KIND_LABEL[kind] : doc.type === 'page' ? 'Wiki page' : 'Material';

  return (
    <aside
      id="kb-doc"
      className={`kb-doc${expanded ? ' is-expanded' : ''}`}
      data-pane="doc"
      data-state={expanded ? 'expanded' : 'open'}
      aria-label="Document"
      style={expanded ? undefined : { width }}
    >
      <header className="kb-head kb-head--doc">
        <span className="kb-doc__type">
          {kind && <Icon name={KIND_ICON[kind]} size={14} />}
          {state.load === 'page' && <Icon name={state.page.kind === 'analysis' ? 'analysis' : state.page.kind === 'note' ? 'note' : 'concept'} size={14} />}
          <span>{typeLabel}</span>
        </span>
        <span className="kb-head__spacer" />
        <IconButton
          icon={expanded ? 'collapse' : 'expand'}
          label={expanded ? 'Back to side panel' : 'Expand to the centre'}
          aria-pressed={expanded}
          onClick={toggle}
        />
        <IconButton icon="close" label="Close document" onClick={closeDoc} />
      </header>
      <div className="kb-doc__body" ref={bodyRef}>
        {state.load === 'loading' && <div className="kb-doc__wait"><Spinner label="Opening the document" /></div>}
        {state.load === 'error' && <Banner tone="error" title={doc.type === 'page' ? 'Couldn’t open this page.' : 'Couldn’t open this material.'}>{state.error}</Banner>}
        {state.load === 'ready' && (
          <article className={`kb-doc__article${expanded ? ' is-wide' : ''}`}>
            <h2 className="kb-doc__title">{state.material.title}</h2>
            <p className="kb-doc__meta">
              {[folder, new Date(state.material.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
                state.material.languages.join(', ')].filter(Boolean).join(' · ')}
            </p>
            {state.material.fragments.length === 0 ? (
              <EmptyState icon="text" title="No text yet" compact>
                The source has no fragments yet.
              </EmptyState>
            ) : state.material.fragments.map((f) => (
              <div key={f.id} className={`kb-frag${doc.seg === f.seg ? ' is-target' : ''}`} data-seg={f.seg}
                {...quoteAttrs({ source: 'material', id: state.material.id, seg: f.seg })}>
                {(f.speaker || f.start_ms !== null || f.page !== null) && (
                  <div className="kb-frag__head">
                    {f.speaker && <span className="kb-frag__speaker">{f.speaker}</span>}
                    {f.start_ms !== null && <span className="kb-frag__time">{formatTime(f.start_ms)}</span>}
                    {f.page !== null && <span className="kb-frag__time">p. {f.page}</span>}
                  </div>
                )}
                <p className="kb-frag__text">{f.text}</p>
              </div>
            ))}
          </article>
        )}
        {state.load === 'page' && (
          <article className={`kb-doc__article${expanded ? ' is-wide' : ''}`}>
            <h2 className="kb-doc__title">{state.page.title}</h2>
            {state.page.kind === 'analysis' && <p className="kb-doc__meta">Saved from a chat · not a source</p>}
            {state.page.blocks.map((b) => (
              <p key={b.id} className={`kb-frag__text${doc.block_id === b.id ? ' is-target' : ''}`} data-block={b.id}
                {...quoteAttrs({ source: 'page', id: state.page.id, block_id: b.id })}>{b.text}</p>
            ))}
          </article>
        )}
      </div>
    </aside>
  );
}
