import { useCallback, useMemo, useRef, useState } from 'react';
import type { KbBlock, KbJob, KbPage } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { AnswerMarkdown, type InAppLink } from '../ui/AnswerMarkdown';
import { Banner, Button, EmptyState, Icon, IconButton, Menu, Spinner } from '../ui';
import { useServices, useUi } from '../state/context';
import type { DocTarget } from '../state/document';
import {
  FolderTag, PAGE_KIND_ICON, PAGE_KIND_LABEL, PageChip, PanelFrameButtons, useAskAbout, useFolderTone,
} from '../document/parts';
import { blockMarkdown, inAppTarget, plural, readableBlockText, relativeTime } from '../document/text';
import { useInterval, useLoad } from '../document/useLoad';
import { useScrollTarget } from '../document/useScrollTarget';
import { canEdit, CLAIM_ICON, CLAIM_LABEL, groupSections, isEditedByUser, isNavigation, namesItsKind, type ClaimKind } from './blocks';
import { quoteAttrs, type QuoteSource } from '../ui/Selection';
import { SourceMarks, SourcesProvider, SourcesRow } from '../cite/SourceMarks';
import { indexSources } from '../cite/sources';

const NO_CITES: never[] = [];

/**
 * Block text rendered by the old UI's safe Markdown renderer (no raw HTML, http(s) links only);
 * its wikilinks to pages and materials open them here (QA C1/C2).
 */
function BlockMarkdown({ block, quote }: { block: KbBlock; quote: QuoteSource }) {
  const openDocument = useUi((s) => s.openDocument);
  const inAppLink = useCallback<InAppLink>((href, label, key) => {
    const target = inAppTarget(href);
    if (!target) return null;
    return (
      <button key={key} type="button" className="kb-wikilink" data-link={target.type}
        onClick={() => openDocument(target)}>{label}</button>
    );
  }, [openDocument]);
  // Quotable: a selection here becomes a quote token of this block (ui/Selection.tsx).
  return (
    <div className="kb-md" {...quoteAttrs(quote)}>
      <AnswerMarkdown content={blockMarkdown(block.text, block.links, block.owner !== 'user')} citations={NO_CITES}
        activeSessionId={null} onCite={() => undefined} inAppLink={inAppLink} />
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

/** A re-check that ended without a result: the job's own reason, and whether Settings fixes it. */
export interface RecheckFailure {
  message: string;
  agentUnavailable: boolean;
}

/** `KbJob.error_code`: the agent can't work until it is fixed in Settings → Accounts & keys. */
const AGENT_UNAVAILABLE = 'AGENT_UNAVAILABLE';

/** Why a finished re-check job did not change the block, in the words the user reads. */
export function recheckFailure(job: KbJob): RecheckFailure | null {
  if (job.state === 'done' || job.state === 'running') return null;
  const fallback = job.state === 'failed' ? 'The re-check failed.' : 'The re-check was stopped before it finished.';
  return { message: job.error?.trim() || fallback, agentUnavailable: job.error_code === AGENT_UNAVAILABLE };
}

interface BlockActions {
  edit: (block: KbBlock, text: string) => Promise<string | null>;
  recheck: (block: KbBlock) => Promise<string | null>;
  remove: (block: KbBlock) => Promise<string | null>;
  rechecking: (blockId: string) => boolean;
  failure: (blockId: string) => RecheckFailure | null;
  dismissFailure: (blockId: string) => void;
}

function RecheckFailed({ failure, onRetry, onDismiss }: { failure: RecheckFailure; onRetry: () => void; onDismiss: () => void }) {
  const openSettings = useUi((s) => s.openSettings);
  return (
    <div className="kb-block__failed" role="alert">
      <p className="kb-inline-error"><b>Couldn’t re-check against sources.</b> {failure.message}</p>
      <div className="kb-block__failed-actions">
        {/* The agent can't work (none connected, signed out, outdated): the fix is in Settings, a
            retry alone would fail the same way, so it comes first. */}
        {failure.agentUnavailable && (
          <Button size="sm" variant="outline" icon="settings" onClick={() => openSettings('conn')}>Open Accounts &amp; keys</Button>
        )}
        <Button size="sm" variant="quiet" icon="retry" onClick={onRetry}>Try again</Button>
        <Button size="sm" variant="quiet" onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  );
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

function Block({ pageId, block, label, actions }: { pageId: string; block: KbBlock; label: boolean; actions: BlockActions }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = isEditedByUser(block);
  const busy = actions.rechecking(block.id);
  const failure = busy ? null : actions.failure(block.id);
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
          <BlockMarkdown block={block} quote={{ source: 'page', id: pageId, block_id: block.id }} />
          {block.citations.length > 0 && (
            <span className="kb-block__cites"><SourceMarks citations={block.citations} /></span>
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
      {!editing && failure && (
        <RecheckFailed failure={failure} onDismiss={() => actions.dismissFailure(block.id)}
          onRetry={() => void run(() => actions.recheck(block))} />
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
  // Numbers follow the reading order of the whole page, collapsed sections included.
  const sources = useMemo(() => indexSources(groupSections(page.blocks).flatMap((s) => s.blocks.flatMap((b) => b.citations))), [page.blocks]);
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
      <SourcesProvider index={sources}>
        {sections.map((section) => {
          const open = !collapsed.has(section.key);
          const title = section.title ?? (section.kind ? CLAIM_LABEL[section.kind] : 'Summary');
          const headId = `kb-sec-${section.key.replace(/\W+/g, '-')}`;
          return (
            <section key={section.key} className={`kb-psec${section.kind ? ` kb-psec--${section.kind}` : ''}`} aria-labelledby={headId}>
              <h3 className="kb-psec__head" id={headId}>
                <button type="button" className="kb-psec__toggle" aria-expanded={open} onClick={() => toggle(section.key)}>
                  <Icon name="chevronDown" size={13} className={`kb-psec__chev${open ? '' : ' is-closed'}`} />
                  {section.kind && namesItsKind(section) && <Icon name={CLAIM_ICON[section.kind]} size={13} className="kb-psec__kind" />}
                  <span className="kb-psec__title">{title}</span>
                </button>
                {section.kind && !namesItsKind(section) && <ClaimLabel kind={section.kind} />}
              </h3>
              {open && (
                <div className="kb-psec__body">
                  {section.blocks.map((b) => (
                    <Block key={b.id} pageId={page.id} block={b} label={section.kind === null && b.kind !== 'from_source' && !isNavigation(b)} actions={actions} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </SourcesProvider>
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
      <SourcesRow index={sources} />
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
  const { client } = useServices();
  const askAbout = useAskAbout();
  const expanded = useUi((s) => s.docExpanded);
  const openGraph = useUi((s) => s.openGraph);
  const tone = useFolderTone();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [failures, setFailures] = useState<Record<string, RecheckFailure>>({});
  const { state, reload, set } = useLoad(target.id, async () => await client.call('GET /kb/wiki/pages/{page_id}', { path: { page_id: target.id } }));
  const page = state.value;
  useScrollTarget(bodyRef.current, target.block_id ?? null, nonce, state.load === 'ready');

  useInterval(Object.keys(jobs).length > 0, 1500, () => {
    for (const [blockId, jobId] of Object.entries(jobs)) {
      client.call('GET /kb/jobs/{job_id}', { path: { job_id: jobId } }).then((job: KbJob) => {
        if (job.state === 'running') return;
        setJobs((j) => { const next = { ...j }; delete next[blockId]; return next; });
        // A failed or stopped re-check says why next to the block (never a silent return).
        const failed = recheckFailure(job);
        if (failed) setFailures((f) => ({ ...f, [blockId]: failed }));
        reload();
      }, (error: unknown) => {
        setJobs((j) => { const next = { ...j }; delete next[blockId]; return next; });
        setFailures((f) => ({ ...f, [blockId]: { message: `SKAZ lost track of the re-check: ${errorText(error)}`, agentUnavailable: false } }));
      });
    }
  });

  const pathOf = (block: KbBlock) => ({ page_id: target.id, block_id: block.id });
  const actions: BlockActions = {
    edit: async (block, text) => {
      try { set(await client.call('PUT /kb/wiki/pages/{page_id}/blocks/{block_id}', { path: pathOf(block), body: { text } })); return null; }
      catch (error) { return errorText(error); }
    },
    recheck: async (block) => {
      try {
        const job = await client.call('POST /kb/wiki/pages/{page_id}/blocks/{block_id}/recheck', { path: pathOf(block) });
        setFailures((f) => { const next = { ...f }; delete next[block.id]; return next; });
        setJobs((j) => ({ ...j, [block.id]: job.id }));
        return null;
      } catch (error) { return errorText(error); }
    },
    remove: async (block) => {
      try { set(await client.call('DELETE /kb/wiki/pages/{page_id}/blocks/{block_id}', { path: pathOf(block) })); return null; }
      catch (error) { return errorText(error); }
    },
    rechecking: (blockId) => blockId in jobs,
    failure: (blockId) => failures[blockId] ?? null,
    dismissFailure: (blockId) => setFailures((f) => { const next = { ...f }; delete next[blockId]; return next; }),
  };
  const addNote = async (text: string) => {
    try { set(await client.call('POST /kb/wiki/pages/{page_id}/blocks', { path: { page_id: target.id }, body: { text } })); return null; }
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
                { id: 'graph', label: 'Show the graph', icon: 'graph', onSelect: () => openGraph(page?.id) },
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
