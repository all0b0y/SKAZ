import { useEffect, useRef, useState } from 'react';
import type { KbStudyShelfEntry } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { PAGE_KIND_ICON } from '../document/parts';
import { useLoad } from '../document/useLoad';
import { useLibrary, usePrefs, useServices, useUi } from '../state/context';
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
 * Saved decks and tests, apart from the wiki's pages (N4-7): decks, tests and what is archived (N4-8).
 * An archived test's questions and mistakes stay with the agent; here it is only hidden. It lives in the
 * side panel until the Study section takes it over. In an empty wiki the panel's one «The wiki is empty»
 * speaks for an empty list too (FIX1 R6).
 */
export function StudyShelf({ wikiEmpty }: { wikiEmpty: boolean }) {
  const { client, prefs } = useServices();
  const { state, reload } = useLoad('study-library', () => studyApi.library(client));
  const decksOpen = usePrefs((s) => s.wikiOpen.deck);
  const testsOpen = usePrefs((s) => s.wikiOpen.test);
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
    ? !wikiEmpty && <EmptyState icon="wiki" title={`No ${label} yet`} compact>{EMPTY_HINT[kind]}</EmptyState>
    : <ul className="kb-list" aria-label={label}>{entries.map((e) => <ShelfRow key={e.page_id} entry={e} act={act} />)}</ul>);
  return (
    <>
      <h3 className="kb-subhead" id="kb-study-shelf">Study</h3>
      <Fold id="deck" label="Decks" count={shelf.decks.length} open={decksOpen} onToggle={() => prefs.getState().setWikiOpen('deck', !decksOpen)}>
        {list(shelf.decks, 'deck', 'decks')}
      </Fold>
      <Fold id="test" label="Tests" count={shelf.tests.length} open={testsOpen} onToggle={() => prefs.getState().setWikiOpen('test', !testsOpen)}>
        {list(shelf.tests, 'test', 'tests')}
      </Fold>
      {shelf.archived.length > 0 && (
        <Fold id="archived" label="Archived" count={shelf.archived.length} open={archivedOpen} onToggle={() => setArchivedOpen(!archivedOpen)}>
          <ul className="kb-list" aria-label="archived">
            {shelf.archived.map((entry) => (
              <li key={entry.page_id} className="kb-shelf__archived">
                <span className="kb-row__text">{entry.title}</span>
                <Button size="sm" variant="quiet" aria-label={`Bring back ${entry.title}`}
                  onClick={() => void act(() => studyApi.unarchive(client, entry.page_id))}>Bring back</Button>
              </li>
            ))}
          </ul>
        </Fold>
      )}
      {(error ?? (state.load === 'error' ? state.error : null)) && (
        <p className="kb-inline-error" role="alert">{error ?? (state.load === 'error' ? state.error : '')}</p>
      )}
    </>
  );
}

/** The manual delete's line (N4-8): says what goes along; holds even when its details can't be read. */
export function StudyDeleteWarning({ pageId }: { pageId: string }) {
  const { client } = useServices();
  const { state } = useLoad(`study-delete-${pageId}`, () => studyApi.deleteWarning(client, pageId));
  return <p className="kb-shelf__warning" role="note">{state.value?.text ?? 'Its mistake history goes too. This can’t be undone.'}</p>;
}
