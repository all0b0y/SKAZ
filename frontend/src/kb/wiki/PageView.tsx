import { useRef, useState } from 'react';
import { normalizePage, type KbBlock, type KbJob, type KbPage } from '../api/b2-u3';
import { errorText } from '../api/client';
import { AnswerMarkdown } from '../../components/assistant/AnswerMarkdown';
import { Banner, Button, EmptyState, Icon, IconButton, Menu, Spinner } from '../ui';
import { useServices, useUi } from '../state/context';
import type { DocTarget } from '../state/document';
import {
  askAbout, CitationChip, FolderTag, PAGE_KIND_ICON, PAGE_KIND_LABEL, PageChip, PanelFrameButtons, useFolderTone,
} from '../document/parts';
import { plural, readableBlockText, relativeTime } from '../document/text';
import { useInterval, useLoad } from '../document/useLoad';
import { useScrollTarget } from '../document/useScrollTarget';
import { canEdit, CLAIM_ICON, CLAIM_LABEL, groupSections, isEditedByUser, type ClaimKind } from './blocks';

const NO_CITES: never[] = [];

/** Block text rendered by the old UI's safe Markdown renderer (no raw HTML, http(s) links only). */
function BlockMarkdown({ text }: { text: string }) {
  return (
    <div className="kb-md">
      <AnswerMarkdown content={readableBlockText(text)} citations={NO_CITES} activeSessionId={null} onCite={() => undefined} />
    </div>
  );
}

/** Statement-type label: icon + caption + its own pill style (decision 20). */
export function ClaimLabel({ kind, edited = false }: { kind: ClaimKind; edited?: boolean }) {
  return (
    <span className={`kb-claim kb-claim--${edited ? 'edited' : kind}`} data-claim={edited ? 'edited' : kind}>
      <Icon name={edited ? 'pencil' : CLAIM_ICON[kind]} size={12} />
      {edited ? 'Edited by you' : CLAIM_LABEL[kind]}
    </span>
  );
}

interface BlockActions {
  edit: (block: KbBlock, text: string) => Promise<string | null>;
  recheck: (block: KbBlock) => Promise<string | null>;
  remove: (block: KbBlock) => Promise<string | null>;
  rechecking: (blockId: string) => boolean;
}

function BlockEditor({ initial, agentBlock, onSave, onCancel, onRecheck }: {
  initial: string;
  agentBlock: boolean;
  onSave: (text: string) => Promise<string | null>;
  onCancel: () => void;
  onRecheck?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!text.trim()) { setError('Write something or cancel.'); return; }
    setBusy(true);
    const result = await onSave(text.trim());
    setBusy(false);
    if (result) setError(result);
  };
  return (
    <div className="kb-edbox">
      <label className="kb-visually-hidden" htmlFor="kb-block-editor">Block text</label>
      <textarea
        id="kb-block-editor"
        className="kb-edbox__text"
        value={text}
        rows={Math.min(10, Math.max(3, Math.ceil(text.length / 60)))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
        }}
        autoFocus
      />
      <div className="kb-edbox__row">
        <span className="kb-edbox__note">
          {agentBlock ? 'The edited block becomes yours — the agent won’t rewrite it.' : 'Your note is never changed by the agent.'}
        </span>
        <span className="kb-head__spacer" />
        <Button size="sm" variant="quiet" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="fill" busy={busy} onClick={() => void save()}>Save</Button>
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
      {onRecheck && (
        <button type="button" className="kb-linkbtn" onClick={onRecheck}>
          <Icon name="models" size={13} />Ask the agent to re-check against sources
        </button>
      )}
    </div>
  );
}

function Block({ block, label, actions }: { block: KbBlock; label: boolean; actions: BlockActions }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = isEditedByUser(block);
  const busy = actions.rechecking(block.id);
  const agentBlock = block.owner !== 'user';
  const run = async (work: () => Promise<string | null>) => {
    setError(null);
    const result = await work();
    if (result) setError(result);
    return result;
  };
  return (
    <div className={`kb-block kb-block--${block.kind}`} data-block-id={block.id} data-target-key={block.id}>
      {(label || edited) && (
        <div className="kb-block__label"><ClaimLabel kind={block.kind} edited={edited} /></div>
      )}
      {editing ? (
        <BlockEditor
          initial={readableBlockText(block.text)}
          agentBlock={agentBlock}
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            const result = await actions.edit(block, text);
            if (!result) setEditing(false);
            return result;
          }}
          onRecheck={agentBlock ? () => { setEditing(false); void run(() => actions.recheck(block)); } : undefined}
        />
      ) : (
        <div className="kb-block__body">
          <BlockMarkdown text={block.text} />
          {block.citations.length > 0 && (
            <span className="kb-block__cites">
              {block.citations.map((c) => <CitationChip key={`${c.material_id}:${c.seg}`} citation={c} />)}
            </span>
          )}
        </div>
      )}
      {!editing && !busy && (canEdit(block) || block.owner === 'user') && (
        <div className="kb-block__icons">
          {canEdit(block) && <IconButton icon="pencil" size="sm" label="Edit block" className="kb-block__edit" onClick={() => setEditing(true)} />}
          {block.owner === 'user' && (
            <IconButton icon="trash" size="sm" label="Delete note" className="kb-block__edit" onClick={() => void run(() => actions.remove(block))} />
          )}
        </div>
      )}
      {!editing && (busy || edited) && (
        <div className="kb-block__tools">
          {busy && <span className="kb-block__busy"><Spinner label="Re-checking against sources" size="sm" />Re-checking against sources…</span>}
          {edited && !busy && (
            <button type="button" className="kb-linkbtn" onClick={() => void run(() => actions.recheck(block))}>
              <Icon name="models" size={13} />Ask the agent to re-check against sources
            </button>
          )}
        </div>
      )}
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </div>
  );
}

function PageBody({ page, actions, noteOpen, setNoteOpen, addNote }: {
  page: KbPage;
  actions: BlockActions;
  noteOpen: boolean;
  setNoteOpen: (open: boolean) => void;
  addNote: (text: string) => Promise<string | null>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const sections = groupSections(page.blocks);
  const toggle = (key: string) => setCollapsed((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <>
      {page.is_analysis_source_forbidden && (
        <div className="kb-note-box" role="note">
          <Icon name="models" size={14} />
          <span><b>Not a source.</b> Saved from a chat. The agent reads it for orientation but cites only the original materials.</span>
        </div>
      )}
      {sections.length === 0 && !noteOpen && (
        <EmptyState icon="wiki" title="This page has no statements yet" compact />
      )}
      {sections.map((section) => {
        const open = !collapsed.has(section.key);
        const title = section.title ?? (section.kind ? CLAIM_LABEL[section.kind] : 'Summary');
        const headId = `kb-sec-${section.key.replace(/\W+/g, '-')}`;
        return (
          <section key={section.key} className={`kb-psec${section.kind ? ` kb-psec--${section.kind}` : ''}`} aria-labelledby={headId}>
            <h3 className="kb-psec__head" id={headId}>
              <button type="button" className="kb-psec__toggle" aria-expanded={open} onClick={() => toggle(section.key)}>
                <Icon name="chevronDown" size={13} className={`kb-psec__chev${open ? '' : ' is-closed'}`} />
                <span className="kb-psec__title">{title}</span>
              </button>
              {section.kind && <ClaimLabel kind={section.kind} />}
            </h3>
            {open && (
              <div className="kb-psec__body">
                {section.blocks.map((b) => (
                  <Block key={b.id} block={b} label={section.kind === null && b.kind !== 'from_source'} actions={actions} />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {noteOpen && (
        <section className="kb-psec kb-psec--user_note" aria-label="New note">
          <h3 className="kb-psec__head"><span className="kb-psec__title">My note</span><ClaimLabel kind="user_note" /></h3>
          <BlockEditor initial="" agentBlock={false} onCancel={() => setNoteOpen(false)}
            onSave={async (text) => {
              const result = await addNote(text);
              if (!result) setNoteOpen(false);
              return result;
            }} />
        </section>
      )}
      {(page.related.length > 0 || page.mentioned_in.length > 0) && (
        <footer className="kb-pfoot">
          {page.related.length > 0 && (
            <>
              <h3 className="kb-pfoot__head">Related</h3>
              <div className="kb-chips">{page.related.map((p) => <PageChip key={p.id} page={p} />)}</div>
            </>
          )}
          {page.mentioned_in.length > 0 && (
            <>
              <h3 className="kb-pfoot__head">Mentioned in</h3>
              <div className="kb-chips">{page.mentioned_in.map((p) => <PageChip key={p.id} page={p} />)}</div>
            </>
          )}
        </footer>
      )}
    </>
  );
}

/** Wiki page in the right panel (v7–v8, decisions 20–22). */
export function PageView({ target, nonce }: { target: DocTarget; nonce: number }) {
  const { u3 } = useServices();
  const expanded = useUi((s) => s.docExpanded);
  const openGraph = useUi((s) => s.openGraph);
  const tone = useFolderTone();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const { state, reload, set } = useLoad(target.id, async () => normalizePage(await u3.call('GET /kb/wiki/pages/{page_id}', { path: { page_id: target.id } })));
  const page = state.value;
  useScrollTarget(bodyRef.current, target.block_id ?? null, nonce, state.load === 'ready');

  useInterval(Object.keys(jobs).length > 0, 1500, () => {
    for (const [blockId, jobId] of Object.entries(jobs)) {
      u3.call('GET /kb/jobs/{job_id}', { path: { job_id: jobId } }).then((job: KbJob) => {
        if (job.state === 'running') return;
        setJobs((j) => { const next = { ...j }; delete next[blockId]; return next; });
        reload();
      }, () => {
        setJobs((j) => { const next = { ...j }; delete next[blockId]; return next; });
      });
    }
  });

  const pathOf = (block: KbBlock) => ({ page_id: target.id, block_id: block.id });
  const actions: BlockActions = {
    edit: async (block, text) => {
      try { set(normalizePage(await u3.call('PUT /kb/wiki/pages/{page_id}/blocks/{block_id}', { path: pathOf(block), body: { text } }))); return null; }
      catch (error) { return errorText(error); }
    },
    recheck: async (block) => {
      try {
        const job = await u3.call('POST /kb/wiki/pages/{page_id}/blocks/{block_id}/recheck', { path: pathOf(block) });
        setJobs((j) => ({ ...j, [block.id]: job.id }));
        return null;
      } catch (error) { return errorText(error); }
    },
    remove: async (block) => {
      try { set(normalizePage(await u3.call('DELETE /kb/wiki/pages/{page_id}/blocks/{block_id}', { path: pathOf(block) }))); return null; }
      catch (error) { return errorText(error); }
    },
    rechecking: (blockId) => blockId in jobs,
  };
  const addNote = async (text: string) => {
    try { set(normalizePage(await u3.call('POST /kb/wiki/pages/{page_id}/blocks', { path: { page_id: target.id }, body: { text } }))); return null; }
    catch (error) { return errorText(error); }
  };

  const kind = page?.kind ?? 'concept';
  return (
    <>
      <header className="kb-head kb-head--doc">
        <span className="kb-doc__type">
          <Icon name={PAGE_KIND_ICON[kind]} size={14} />
          <span>{page ? PAGE_KIND_LABEL[kind] : 'Wiki page'}</span>
        </span>
        <span className="kb-head__spacer" />
        <PanelFrameButtons
          more={(
            <>
              <IconButton ref={moreRef} icon="more" label="Page actions" aria-haspopup="menu" aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)} />
              <Menu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={moreRef} label="Page actions" items={[
                { id: 'graph', label: 'Show the graph', icon: 'graph', onSelect: () => openGraph() },
                { id: 'reload', label: 'Read the page again', icon: 'retry', onSelect: () => reload() },
              ]} />
            </>
          )}
        >
          <IconButton icon="chats" label="Ask about page" disabled={!page}
            onClick={() => page && askAbout({ type: 'page', id: page.id, title: page.title })} />
          <IconButton icon="newChat" label="My note" disabled={!page} aria-pressed={noteOpen}
            onClick={() => setNoteOpen(true)} />
        </PanelFrameButtons>
      </header>
      <div className="kb-doc__body" ref={bodyRef}>
        {state.load === 'loading' && !page && <div className="kb-doc__wait"><Spinner label="Opening the page" /></div>}
        {state.load === 'error' && (
          <Banner tone="error" title="Couldn’t open this page."
            actions={<Button size="sm" icon="retry" onClick={reload}>Try again</Button>}>{state.error}</Banner>
        )}
        {page && (
          <article className={`kb-doc__article kb-page${expanded ? ' is-wide' : ''}`} data-page-kind={page.kind}>
            <h2 className="kb-doc__title">{page.title}</h2>
            <div className="kb-page__meta">
              {page.folder_names.map((name, i) => <FolderTag key={name} name={name} tone={tone(page.folders[i])} />)}
              <span className="kb-doc__meta">
                {[plural(page.folder_names.length, 'folder'), plural(page.sources.length, 'source'),
                  page.updated_at ? `updated ${relativeTime(page.updated_at)}` : ''].filter(Boolean).join(' · ')}
              </span>
            </div>
            <PageBody page={page} actions={actions} noteOpen={noteOpen} setNoteOpen={setNoteOpen} addNote={addNote} />
          </article>
        )}
      </div>
    </>
  );
}
