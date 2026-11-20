import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { KbGraphCreate, KbGraphEntries, KbGraphEntry, KbGraphMe } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { Button, Switch } from '../ui';
import { MeStorageNote } from './MeSection';

const AREA: Record<KbGraphEntry['area'], string> = {
  chat: 'Chat', practice: 'Practice', personal: 'Personal profile',
};
const STATUS: Record<KbGraphEntry['status'], string> = {
  ready: 'In use', not_used: 'Not used', needs_context: 'Not used', shadow: 'Learning · not used',
};
type Inline = { id: string; mode: 'why' | 'edit' | 'history' | 'forget' };
type LearningKey = 'study' | 'chat' | 'personal';
const LEARNING: ReadonlyArray<{ key: LearningKey; title: string; hint: string }> = [
  { key: 'study', title: 'Learn from Study', hint: 'Notice choices such as trying a problem before opening the walkthrough.' },
  { key: 'chat', title: 'Learn from Chat', hint: 'Notice actions in new turns, such as returning to the original question.' },
  { key: 'personal', title: 'Use personal facts', hint: 'Separate from instructions and observed patterns.' },
];

function EntryForm({ item, busy, onSave, onCancel }: {
  item?: KbGraphEntry;
  busy: boolean;
  onSave: (text: string, area: KbGraphCreate['area']) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(item?.text ?? '');
  const [area, setArea] = useState<KbGraphCreate['area']>(item?.area ?? 'chat');
  return (
    <form className="kb-me-graph__detail kb-me-graph__form" onSubmit={(e) => {
      e.preventDefault();
      if (text.trim() && !busy) onSave(text.trim(), area);
    }}>
      <strong>{item?.kind === 'observed' ? 'Add an explicit correction' : item ? 'Edit entry' : 'Add an instruction'}</strong>
      <label>Instruction or fact
        <textarea className="kb-attachform__input" rows={2} required value={text} autoFocus
          maxLength={(item?.text.length ?? 0) > 600 ? 20_000 : 600} onChange={(e) => setText(e.currentTarget.value)} />
      </label>
      <label>Applies in
        <select className="kb-select" value={area} disabled={item?.kind === 'observed'}
          onChange={(e) => setArea(e.currentTarget.value as KbGraphCreate['area'])}>
          {(Object.entries(AREA)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <div className="kb-me-graph__actions">
        <Button type="submit" size="sm" disabled={!text.trim()} busy={busy}>Save</Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function MeGraphSection({ view }: { view: KbGraphMe }) {
  const { client, settings } = useServices();
  const prefix = useId();
  const [page, setPage] = useState<KbGraphEntries | null>(null);
  const [inline, setInline] = useState<Inline | null>(null);
  const [add, setAdd] = useState(false);
  const [access, setAccess] = useState(false);
  const [erase, setErase] = useState(false);
  const [history, setHistory] = useState<KbGraphEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const openTrigger = useRef<HTMLButtonElement | null>(null);
  const openedAt = useRef<number | null>(null);
  const detailPanel = useRef<HTMLDivElement | null>(null);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const eraseTrigger = useRef<HTMLButtonElement | null>(null);
  const openId = inline?.id;

  useLayoutEffect(() => {
    const detail = detailPanel.current;
    const host = detail?.closest('.kb-settings__content');
    const row = openTrigger.current?.closest('.kb-me-graph__row');
    if (!openId || !detail || !host || !row) return;
    const bounds = host.getBoundingClientRect();
    const overflow = detail.getBoundingClientRect().bottom - bounds.bottom;
    const room = row.getBoundingClientRect().top - bounds.top;
    host.scrollTop += Math.min(Math.max(overflow, 0), Math.max(room, 0));
  }, [openId]);

  useEffect(() => {
    if (view.status !== 'migrating') return;
    const timer = window.setTimeout(() => void settings.getState().loadMe(), 250);
    return () => window.clearTimeout(timer);
  }, [settings, view]);

  useEffect(() => {
    if (view.status !== 'ready') return;
    let current = true;
    setReadError(null);
    void client.call('GET /kb/me/entries').then(
      (value) => { if (current) setPage(value); },
      (reason: unknown) => { if (current) setReadError(errorText(reason)); },
    );
    return () => { current = false; };
  }, [client, view.revision, view.status, refresh]);

  useEffect(() => {
    if (inline?.mode !== 'history') return;
    let current = true;
    setHistory(null);
    void client.call('GET /kb/me/entries/{entry_id}/history', { path: { entry_id: inline.id } }).then(
      ({ versions }) => { if (current) setHistory(versions); },
      (reason: unknown) => { if (current) setError(errorText(reason)); },
    );
    return () => { current = false; };
  }, [client, inline, view.revision]);

  const run = async (action: () => Promise<unknown>, message = '', after?: () => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await action();
      await settings.getState().loadMe();
      setRefresh((n) => n + 1);
      setNotice(message);
      after?.();
    } catch (reason) {
      setError(errorText(reason));
      // A stale form stays open so the user can review it against the latest revision.
      await settings.getState().loadMe();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const closeAdd = () => { setAdd(false); addTrigger.current?.focus(); };
  const closeErase = () => { setErase(false); eraseTrigger.current?.focus(); };
  const closeWhy = () => {
    setInline(null);
    const trigger = openTrigger.current;
    const host = trigger?.closest('.kb-settings__content');
    if (host && openedAt.current !== null) host.scrollTop = openedAt.current;
    trigger?.focus({ preventScroll: true });
  };
  const closeDetail = () => {
    if (inline) setInline({ id: inline.id, mode: 'why' });
    detailTrigger.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !(add || erase || inline)) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    if (erase) closeErase();
    else if (add) closeAdd();
    else if (inline?.mode === 'why') closeWhy();
    else closeDetail();
  };

  if (view.status === 'migrating') {
    return (
      <div className="kb-me-graph__detail" role="status">
        <strong>Moving your existing entries</strong>
        <p>Checking the copy before switching. No new activity is collected.</p>
      </div>
    );
  }
  if (view.status === 'recovery_required') {
    return (
      <div className="kb-me-graph__detail" role="alert">
        <strong>Couldn’t read Me</strong>
        <p>Your entries could not be opened. Chat still works without personalization.</p>
        <Button size="sm" busy={busy} onClick={() => void run(() => client.call('POST /kb/me/retry'))}>Try again</Button>
        {error && <p className="kb-inline-error">{error}</p>}
      </div>
    );
  }

  const patch = (item: KbGraphEntry, data: { text?: string; area?: KbGraphEntry['area']; enabled?: boolean }) =>
    client.call('PATCH /kb/me/entries/{entry_id}', {
      path: { entry_id: item.id }, body: { expected_revision: item.revision, ...data },
    });

  const row = (item: KbGraphEntry) => {
    const selected = inline?.id === item.id;
    const observed = item.kind === 'observed';
    const detailsId = `${prefix}-${item.id}`;
    const section = (mode: Inline['mode'], trigger: HTMLButtonElement) => {
      detailTrigger.current = trigger;
      setInline({ id: item.id, mode: inline?.mode === mode ? 'why' : mode });
    };
    return (
      <div key={item.id}>
        <div className="kb-srow kb-me-graph__row">
          <div>
            {item.title && <strong>{item.title}</strong>}
            <div>{item.text}</div>
            {item.description && <div className="kb-srow__hint">{item.description}</div>}
            <div className="kb-srow__hint">{AREA[item.area]}{item.scoped && item.area === 'chat' && ' · One chat'} · {STATUS[item.status]}</div>
          </div>
          <Button size="sm" variant="quiet" className="kb-me-graph__link" aria-expanded={selected}
            aria-controls={selected ? detailsId : undefined} onClick={(event) => {
              if (selected) closeWhy();
              else {
                openTrigger.current = event.currentTarget;
                openedAt.current = event.currentTarget.closest('.kb-settings__content')?.scrollTop ?? null;
                setAdd(false);
                setInline({ id: item.id, mode: 'why' });
              }
            }}>{selected ? 'Close' : 'Why this?'}</Button>
        </div>
        {selected && (
          <div className="kb-me-graph__detail" id={detailsId} ref={detailPanel}>
            <strong>Why this?</strong>
            <p>{item.why}</p>
            <p className="kb-srow__hint">{observed ? 'Observed by SKAZ' : item.origin === 'agent' ? 'Imported' : 'Declared by you'} · {AREA[item.area]} · {STATUS[item.status]}</p>
            <div className="kb-me-graph__actions">
              <Button size="sm" onClick={(e) => section('edit', e.currentTarget)}>{observed ? 'Correct' : 'Edit'}</Button>
              <Button size="sm" disabled={busy} onClick={() => void run(
                () => patch(item, { enabled: !item.enabled }),
              )}>{item.enabled ? 'Don’t use' : 'Allow use'}</Button>
              <Button size="sm" onClick={(e) => section('history', e.currentTarget)}>History</Button>
              <Button size="sm" variant="quiet" className="kb-me-graph__danger" onClick={(e) => section('forget', e.currentTarget)}>Forget…</Button>
            </div>
            {inline.mode === 'edit' && (
              <EntryForm item={item} busy={busy} onCancel={closeDetail} onSave={(text, area) => void run(
                () => patch(item, { text, area }), 'Entry saved.', closeDetail,
              )} />
            )}
            {inline.mode === 'history' && (
              <div className="kb-me-graph__history">
                <strong>History</strong>
                {history === null ? <p role="status">Reading…</p> : history.map((version) => (
                  <div key={version.revision} className="kb-me-graph__version">
                    <span>{observed ? version.why : version.text}</span>
                    {version.revision === item.revision ? <small>Current</small> : !observed && (
                      <Button size="sm" variant="quiet" disabled={busy} onClick={() => void run(() => client.call(
                        'POST /kb/me/entries/{entry_id}/restore', {
                          path: { entry_id: item.id },
                          body: { revision: version.revision, expected_revision: item.revision },
                        },
                      ), 'Revision restored.')}>Restore</Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {inline.mode === 'forget' && (
              <div className="kb-me-graph__confirm">
                <p>Forget this entry and its history? This can’t be undone.</p>
                <div className="kb-me-graph__actions">
                  <Button size="sm" variant="danger" busy={busy} onClick={() => void run(() => client.call(
                    'DELETE /kb/me/entries/{entry_id}', {
                      path: { entry_id: item.id }, query: { expected_revision: item.revision },
                    },
                  ), 'Entry forgotten.', () => { setInline(null); addTrigger.current?.focus(); })}>Forget entry</Button>
                  <Button size="sm" variant="quiet" onClick={closeDetail}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const learn = view.enabled && (view.study || view.chat);
  const declared = page?.entries.filter((entry) => entry.kind !== 'observed') ?? [];
  const patterns = page?.entries.filter((entry) => entry.kind === 'observed') ?? [];
  const summary = !learn ? 'Learning off' : view.study && view.chat ? 'Study and Chat on' : view.study ? 'Study only' : 'Chat only';
  return (
    <div className="kb-me-graph" onKeyDown={onKeyDown}>
      {error && <p className="kb-inline-error kb-me-graph__error" role="alert">{error}</p>}
      <div className="kb-srow kb-me-graph__row">
        <div>
          <div className="kb-srow__label">Use Me in chats</div>
          <div className="kb-srow__hint">{view.enabled ? 'What shapes your answers in chat.' : 'Personalization is off.'}</div>
        </div>
        <Switch label="Use Me in chats" checked={view.enabled} disabled={busy} onChange={(enabled) => void run(
          () => client.call('PUT /kb/me', { body: { enabled, expected_revision: view.revision } }),
        )} />
      </div>
      {!view.enabled && (
        <p className="kb-me-graph__detail">No Me data reaches the agent. New activity isn’t recorded. You can still manage stored entries.</p>
      )}
      <section className="kb-sgroup" aria-label="What you told me">
        <div className="kb-me-graph__head">
          <h4 className="kb-sgroup__title">What you told me</h4>
          <Button ref={addTrigger} size="sm" onClick={() => { setInline(null); setAdd(true); }}>Add entry</Button>
        </div>
        {add && <EntryForm busy={busy} onCancel={closeAdd} onSave={(text, area) => void run(() => client.call(
          'POST /kb/me/entries', { body: { text, area, expected_revision: view.revision } },
        ), 'Entry saved.', closeAdd)} />}
        {readError ? (
          <div role="alert" className="kb-inline-error">
            {readError} <Button size="sm" variant="quiet" onClick={() => setRefresh((n) => n + 1)}>Try again</Button>
          </div>
        ) : !page ? <p role="status" className="kb-sintro">Reading…</p> : declared.length
          ? declared.map(row) : <p className="kb-sintro">No entries here.</p>}
      </section>
      <section className="kb-sgroup" aria-label="Patterns">
        <div className="kb-me-graph__head"><h4 className="kb-sgroup__title">Patterns</h4></div>
        {page && (patterns.length ? patterns.map(row) : (
          <p className="kb-sintro">{learn ? 'No pattern yet. SKAZ needs separate sessions.' : 'No patterns here. Learning is off.'}</p>
        ))}
      </section>
      {page && page.next_offset !== null && (
        <Button size="sm" variant="quiet" disabled={busy} onClick={async () => {
          const offset = page.next_offset;
          if (offset === null) return;
          try {
            const next = await client.call('GET /kb/me/entries', { query: { offset } });
            setPage((current) => current === page
              ? { entries: [...page.entries, ...next.entries], next_offset: next.next_offset } : current);
          } catch (reason) { setError(errorText(reason)); }
        }}>Show more entries</Button>
      )}
      <section className="kb-sgroup" aria-label="Access & learning">
        <div className="kb-me-graph__head">
          <Button size="sm" aria-expanded={access} aria-controls={access ? `${prefix}-access` : undefined}
            onClick={() => { setAccess(!access); setErase(false); }}>Access &amp; learning</Button>
          <span className="kb-srow__hint">{summary}</span>
        </div>
        {access && (
          <div id={`${prefix}-access`}>
            <p className="kb-sintro">SKAZ notices patterns automatically in the sources you enable. Past activity isn’t scanned.</p>
            {LEARNING.map(({ key, title, hint }) => (
              <div className="kb-srow kb-me-graph__row" key={key}>
                <div><div className="kb-srow__label">{title}</div><div className="kb-srow__hint">{hint}</div></div>
                <Switch label={title} checked={view[key]} disabled={busy || !view.enabled} onChange={(checked) => void run(
                  () => client.call('PUT /kb/me/learning', { body: { [key]: checked, expected_revision: view.revision } }),
                )} />
              </div>
            ))}
            <div className="kb-srow kb-me-graph__row">
              <div><div className="kb-srow__label">Erase Me data</div><div className="kb-srow__hint">Remove entries, observations and their history.</div></div>
              <Button ref={eraseTrigger} size="sm" variant="quiet" className="kb-me-graph__danger" onClick={() => setErase(true)}>Erase…</Button>
            </div>
            {erase && (
              <div className="kb-me-graph__confirm">
                <p>Erase all Me data? Learning will be off. You can’t undo this.</p>
                <div className="kb-me-graph__actions">
                  <Button size="sm" variant="danger" busy={busy} onClick={() => void run(
                    () => client.call('DELETE /kb/me/data', { query: { expected_revision: view.revision } }),
                    'All Me data erased. Learning is off.', () => { setInline(null); setAdd(false); closeErase(); },
                  )}>Erase all Me data</Button>
                  <Button size="sm" variant="quiet" onClick={closeErase}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
      {notice && <p className="kb-sintro" role="status">{notice}</p>}
      <MeStorageNote />
    </div>
  );
}
