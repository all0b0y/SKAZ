import { useEffect, useRef, useState } from 'react';
import type { KbStudyShelfEntry } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { PAGE_KIND_ICON } from '../document/parts';
import { useLoad } from '../document/useLoad';
import { useLibrary, useServices, useUi } from '../state/context';
import { Button, EmptyState, Icon } from '../ui';
import { studyApi } from './api';

const EMPTY_HINT = {
  deck: 'Ask an agent for flashcards from your materials, then “Save to Study” in the block.',
  test: 'Ask an agent for a test from your materials, then “Save to Study” in the block.',
};

type Act = (work: () => Promise<unknown>) => Promise<void>;

function ShelfRow({ entry, act }: { entry: KbStudyShelfEntry; act: Act }) {
  const { client } = useServices();
  const openDocument = useUi((s) => s.openDocument);
  const current = useUi((s) => s.right?.kind === 'doc' && s.right.target.type === 'page' && s.right.target.id === entry.page_id);
  return (
    <li>
      <button type="button" className={`kb-row${current ? ' is-current' : ''}`} aria-current={current ? 'true' : undefined}
        onClick={() => openDocument({ type: 'page', id: entry.page_id })}>
        <Icon name={PAGE_KIND_ICON[entry.kind]} size={16} className="kb-row__icon" />
        <span className="kb-row__text">{entry.title}</span>
      </button>
      {entry.suggest_archive && (
        <div className="kb-shelf__hint">
          <span className="kb-shelf__badge">Archive suggested</span>
          <p>All learned and not opened for a long time. Archive it? SKAZ won’t do it by itself.</p>
          <div className="kb-shelf__actions">
            <Button size="sm" onClick={() => void act(() => studyApi.archive(client, entry.page_id))}>Archive</Button>
            <Button size="sm" variant="quiet" onClick={() => void act(() => studyApi.keep(client, entry.page_id))}>Not now</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function Fold({ id, label, count, open, onToggle, children }: {
  id: string; label: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  const bodyId = `kb-study-body-${id}`;
  return (
    <div className="kb-wfold" data-kind={id}>
      <h3 className="kb-wfold__head">
        <button type="button" className="kb-row kb-wfold__toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <Icon name="chevronRight" size={14} className={`kb-wfold__chev${open ? ' is-open' : ''}`} />
          <span className="kb-row__text kb-wfold__label">{label}</span>
          <span className="kb-row__count">{count}</span>
        </button>
      </h3>
      <div className={`kb-fold${open ? ' is-open' : ''}`} id={bodyId} data-open={open ? 'true' : 'false'}>
        <div className="kb-fold__in" {...(open ? {} : { inert: '' })}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Study section in the side panel (N4-7, N4-8, F6): saved decks, tests, and what is archived,
 * kept apart from the wiki's concept/note/analysis/folder pages. An archived test's questions and
 * mistakes stay with the agent; here it is only hidden.
 */
export function StudyShelf({ wikiEmpty = false }: { wikiEmpty?: boolean } = {}) {
  const { client } = useServices();
  const { state, reload } = useLoad('study-library', () => studyApi.library(client));
  const [decksOpen, setDecksOpen] = useState(true);
  const [testsOpen, setTestsOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useLibrary((s) => s.revision);
  const seen = useRef(revision);
  useEffect(() => { if (seen.current !== revision) { seen.current = revision; reload(); } }, [revision, reload]);
  const act: Act = async (work) => {
    setError(null);
    try { await work(); reload(); } catch (e) { setError(errorText(e)); }
  };
  const shelf = state.value ?? { decks: [], tests: [], archived: [] };
  const list = (entries: KbStudyShelfEntry[], kind: 'deck' | 'test', label: string) => (entries.length === 0
    ? !wikiEmpty && <EmptyState icon={PAGE_KIND_ICON[kind]} title={`No ${label} yet`} compact>{EMPTY_HINT[kind]}</EmptyState>
    : <ul className="kb-list" aria-label={label}>{entries.map((e) => <ShelfRow key={e.page_id} entry={e} act={act} />)}</ul>);
  return (
    <div className="kb-side__scroll">
      <Fold id="deck" label="Decks" count={shelf.decks.length} open={decksOpen} onToggle={() => setDecksOpen(!decksOpen)}>
        {list(shelf.decks, 'deck', 'decks')}
      </Fold>
      <Fold id="test" label="Tests" count={shelf.tests.length} open={testsOpen} onToggle={() => setTestsOpen(!testsOpen)}>
        {list(shelf.tests, 'test', 'tests')}
      </Fold>
      {shelf.archived.length > 0 && (
        <Fold id="archived" label="Archived" count={shelf.archived.length} open={archivedOpen} onToggle={() => setArchivedOpen(!archivedOpen)}>
          <ul className="kb-list" aria-label="archived">
            {shelf.archived.map((entry) => (
              <li key={entry.page_id} className="kb-shelf__archived">
                <div className="kb-shelf__archived-text">
                  <span className="kb-row__text">{entry.title}</span>
                  <span className="kb-shelf__meta">
                    {entry.archived_by === 'auto' ? 'Auto-archived after 60 days' : 'Archived by you'}
                  </span>
                </div>
                <Button size="sm" variant="quiet" aria-label={`Bring back ${entry.title}`}
                  onClick={() => void act(() => studyApi.unarchive(client, entry.page_id))}>Bring back</Button>
              </li>
            ))}
          </ul>
          <p className="kb-side__note">Questions and mistakes stay with the agent; here they are only hidden.</p>
        </Fold>
      )}
      <p className="kb-side__note">Concepts and terms stay in the wiki — only flashcards and tests live here.</p>
      {(error ?? (state.load === 'error' ? state.error : null)) && (
        <p className="kb-inline-error" role="alert">{error ?? (state.load === 'error' ? state.error : '')}</p>
      )}
    </div>
  );
}

/** The manual delete's line (N4-8): says what goes along; holds even when its details can't be read. */
export function StudyDeleteWarning({ pageId }: { pageId: string }) {
  const { client } = useServices();
  const { state } = useLoad(`study-delete-${pageId}`, () => studyApi.deleteWarning(client, pageId));
  return <p className="kb-shelf__warning" role="note">{state.value?.text ?? 'Its mistake history goes too. This can’t be undone.'}</p>;
}
