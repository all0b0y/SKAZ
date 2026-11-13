import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import type { KbSearch } from '../../api/kb/types.gen';
import { createExploreClient } from '../api/explore';
import { useServices } from '../state/context';
import { Button, Icon, IconButton, Menu, Modal, TextField } from '../ui';
import { exploreIssue } from './errors';
import { exploreState, searchStatus, watchSearches } from './exploreState';
import { useCover } from './useCover';

const busy = (s: KbSearch): boolean => s.state === 'running' || s.state === 'queued';

/**
 * EX3 (UX-12): the Explore side list — «Map of your wiki», then the searches like the chat list: each with
 * its live status (running, waiting, +N new). Find above the map creates them; a search opens full page.
 * A row's menu: Rename, Run again (a new search with the same topic and words), Delete.
 */
export function ExploreSide() {
  const { client, ui } = useServices();
  const api = useMemo(() => createExploreClient(client), [client]);
  const store = useMemo(() => exploreState(client, api.searches), [client, api]);
  const page = useStore(store, (s) => s.page);
  const searches = useStore(store, (s) => s.searches);
  const failed = useStore(store, (s) => s.searchesFailed);
  useEffect(() => watchSearches(store), [store]);
  const [renaming, setRenaming] = useState<KbSearch | null>(null);
  const [deleting, setDeleting] = useState<KbSearch | null>(null);
  // A dialog is centred over the window, where the paper's native view would be drawn above it.
  const cover = useCover(store);
  useEffect(() => { cover(renaming !== null || deleting !== null); }, [cover, renaming, deleting]);

  const problem = (error: unknown) => ui.getState().showToast({ text: exploreIssue(error).message, tone: 'problem' });

  const remove = async (search: KbSearch) => {
    try {
      await api.delete_search(search.id);
      // If it was the open one, the page falls back to the map when the list is read again.
      await store.getState().refresh();
      ui.getState().showToast({ text: 'Search deleted. Papers you added stay in Materials.' });
    } catch (error) {
      problem(error);
    }
  };

  const runAgain = async (search: KbSearch) => {
    try {
      const started = await api.start({ area_id: search.area_id, query: search.query, all_topics: !search.area_id && !search.query });
      await store.getState().refresh();
      store.getState().showSearch(started.id);
    } catch (error) {
      problem(error);
    }
  };

  return (
    <nav className="kb-ex-side" aria-label="Explore">
      <button type="button" className={`kb-ex-side__row${page.kind === 'map' ? ' is-on' : ''}`} aria-current={page.kind === 'map' ? 'page' : undefined}
        onClick={() => store.getState().showMap()}>
        <Icon name="compass" size={14} /><span className="kb-ex-side__name">Map of your wiki</span>
      </button>
      <h3 className="kb-ex-side__sub">Searches</h3>
      {failed && <p className="kb-ex-muted kb-ex-side__note" role="alert">Searches could not be read. <button type="button" className="kb-ex-link" onClick={() => void store.getState().refresh()}>Try again</button></p>}
      {searches.length === 0 && !failed && <p className="kb-ex-muted kb-ex-side__note">None yet. Pick a topic on the map and press “Find what&apos;s new”.</p>}
      <ul className="kb-ex-side__list">
        {searches.map((s) => <SearchRow key={s.id} search={s} on={page.kind === 'search' && page.id === s.id}
          onOpen={() => store.getState().showSearch(s.id)} onRename={() => setRenaming(s)} onRunAgain={() => void runAgain(s)}
          onDelete={() => setDeleting(s)} />)}
      </ul>
      {renaming && <RenameDialog search={renaming} onClose={() => setRenaming(null)} onSave={async (name) => {
        await api.rename_search(renaming.id, name);
        await store.getState().refresh();
      }} />}
      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Delete this search?">
        <p>“{deleting?.name}” and its list of papers go. Papers you added stay in Materials.</p>
        <div className="kb-modal__foot">
          <Button variant="quiet" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { const s = deleting; setDeleting(null); if (s) void remove(s); }}>Delete</Button>
        </div>
      </Modal>
    </nav>
  );
}

function SearchRow({ search, on, onOpen, onRename, onRunAgain, onDelete }: {
  search: KbSearch; on: boolean; onOpen: () => void; onRename: () => void; onRunAgain: () => void; onDelete: () => void;
}) {
  const more = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const status = searchStatus(search);
  const mark = search.owner === 'weekly' ? '↻' : search.state === 'running' ? '◌' : search.unseen > 0 ? '●' : '○';
  return (
    <li className={`kb-ex-side__item${on ? ' is-on' : ''}`}>
      <button type="button" className="kb-ex-side__row" aria-current={on ? 'page' : undefined} onClick={onOpen} title={search.name}>
        <span className="kb-ex-side__mark" aria-hidden="true">{mark}</span>
        <span className="kb-ex-side__name">{search.owner === 'weekly' ? 'Weekly · ' : ''}{search.name}</span>
        <span className={`kb-ex-side__status is-${status.tone}`}>{status.text}</span>
      </button>
      <IconButton ref={more} icon="more" label="Search actions" size="sm" className="kb-ex-side__more" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} />
      <Menu open={menu} onClose={() => setMenu(false)} anchorRef={more} label="Search actions" items={[
        { id: 'rename', label: 'Rename…', icon: 'pencil', onSelect: () => { setMenu(false); onRename(); } },
        { id: 'again', label: 'Run again', icon: 'retry', disabled: busy(search), note: busy(search) ? 'Running' : undefined, onSelect: () => { setMenu(false); onRunAgain(); } },
        { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => { setMenu(false); onDelete(); } },
      ]} />
    </li>
  );
}

function RenameDialog({ search, onClose, onSave }: { search: KbSearch; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(search.name);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || working) return;
    setWorking(true);
    try { await onSave(clean); onClose(); } catch (e) { setError(exploreIssue(e).message); setWorking(false); }
  };
  return (
    <Modal open onClose={onClose} title="Rename search">
      <form onSubmit={(e) => void submit(e)}>
        <TextField label="Name" value={name} maxLength={120} autoFocus disabled={working} onChange={(e) => setName(e.target.value)} />
        {error && <p className="kb-inline-error" role="alert">{error}</p>}
        <div className="kb-modal__foot">
          <Button variant="quiet" disabled={working} onClick={onClose}>Cancel</Button>
          <Button variant="fill" type="submit" disabled={working || !name.trim()}>Rename</Button>
        </div>
      </form>
    </Modal>
  );
}
