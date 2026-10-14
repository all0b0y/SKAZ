import { useEffect, useState } from 'react';
import type { KbMaterial } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Banner, EmptyState, IconButton, Spinner } from '../ui';
import { Icon } from '../ui/Icon';
import { useLibrary, useServices, useUi } from '../state/context';
import { KIND_ICON, KIND_LABEL, formatTime } from '../library/materialMeta';

type DocState = { load: 'loading' } | { load: 'ready'; material: KbMaterial } | { load: 'error'; error: string };

/**
 * Right document panel: exists only while something is open. ⤢ gives it the centre, ✕ closes.
 * U1 shows the material's source text read-only; the full material view (translation, fixes,
 * processing chips) is U3.
 */
export function DocPanel({ materialId, expanded, width }: { materialId: string; expanded: boolean; width: number }) {
  const { client } = useServices();
  const closeDoc = useUi((s) => s.closeDoc);
  const toggle = useUi((s) => s.toggleDocExpanded);
  const folders = useLibrary((s) => s.folders);
  const [state, setState] = useState<DocState>({ load: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ load: 'loading' });
    client.material(materialId).then(
      (material) => { if (live) setState({ load: 'ready', material }); },
      (error: unknown) => { if (live) setState({ load: 'error', error: errorText(error) }); },
    );
    return () => { live = false; };
  }, [client, materialId]);

  const kind = state.load === 'ready' ? state.material.kind : null;
  const folder = state.load === 'ready' ? folders.find((f) => f.id === state.material.folder_id)?.name : undefined;

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
          <span>{kind ? KIND_LABEL[kind] : 'Material'}</span>
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
      <div className="kb-doc__body">
        {state.load === 'loading' && <div className="kb-doc__wait"><Spinner label="Opening the material" /></div>}
        {state.load === 'error' && <Banner tone="error" title="Couldn’t open this material.">{state.error}</Banner>}
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
              <div key={f.id} className="kb-frag">
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
      </div>
    </aside>
  );
}
