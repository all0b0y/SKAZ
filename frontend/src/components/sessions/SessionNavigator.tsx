import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import type { Session } from '../../api/types';
import { deleteGroup, moveSessions, reorderGroups, updateGroup } from '../../lib/sessionGroups';
import { stripTags, tagColorIndex } from '../../lib/sessionTags';
import { Icon } from '../ui/Icon';
import { SessionDialog, SessionMenu, type SessionMenuItem } from './SessionOverlays';
import { useSessionGroups } from './useSessionGroups';
import { useEdgeFade } from '../../hooks/useOverflowEdges';
import { ApiClient } from '../../api/client';
import { mediaSourceLink } from '../../lib/mediaSourceLink';
import './sessionNavigator.css';

// `moveSessions` marks a group created from Move to group: the new group and the
// sessions' membership are committed together, so a failure leaves neither behind.
type Dialog =
  | { kind: 'group'; id: string | null; moveSessions?: string[] }
  | { kind: 'rename' | 'delete-session' | 'delete-group'; id: string }
  | { kind: 'move' | 'delete-sessions'; ids: string[] };
type Drag = { kind: 'session'; ids: string[] } | { kind: 'group'; id: string };
const statusLabel = { recording: 'Recording', paused: 'Paused', stopped: 'Saved' };
/** The bulk delete confirmation names this many sessions, then "…and N more". */
const NAMED_IN_CONFIRMATION = 5;
const sessionsWord = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

/** What the list claims. A stored `recording` status is only true while this
 *  renderer is actually capturing that session; a fresh or interrupted one is
 *  shown as paused rather than pulsing forever. */
function shownStatus(session: Session, capturingId: string | null): Session['status'] {
  return session.status === 'recording' && session.id !== capturingId ? 'paused' : session.status;
}

export function SessionNavigator() {
  const sessions = useStore((s) => s.sessions);
  const imports = useStore((s) => s.imports);
  const activeId = useStore((s) => s.activeSessionId);
  const recorderState = useStore((s) => s.recorderState);
  const noteGenerations = useStore((s) => s.noteGenerations);
  const selectSession = useStore((s) => s.selectSession);
  const renameSession = useStore((s) => s.renameSession);
  const removeSession = useStore((s) => s.removeSession);
  const removeSessions = useStore((s) => s.removeSessions);
  const { data, commit, error, setError } = useSessionGroups(sessions);
  const [filter, setFilter] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<{ kind: 'session' | 'group'; id: string; anchor: DOMRect } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  // Multi-select (Finder style). Ids are kept in list order; `anchor` is where a Shift range starts.
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState('');
  const chipsRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, DOMRect>());
  const isCapturing = ['recording', 'paused', 'processing'].includes(recorderState);
  const capturingId = isCapturing ? activeId : null;
  const groups = preview ? preview.map((id) => data.groups.find((g) => g.id === id)!).filter(Boolean) : data.groups;
  const visible = filter ? sessions.filter((s) => data.membership[s.id] === filter) : sessions;
  // A selected session that disappeared (deleted, moved out of the filter) is simply no longer selected.
  const selected = visible.filter((s) => picked.includes(s.id)).map((s) => s.id);
  const selecting = selected.length > 0;
  // The rail's scrolling body fades where sessions are scrolled away (PANES-SPEC §5).
  const listRef = useRef<HTMLUListElement>(null);
  useEdgeFade(listRef, 'y', visible.length > 0);
  const groupName = (id: string | null) => data.groups.find((g) => g.id === id)?.name ?? 'All';
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? '';

  useLayoutEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, DOMRect>();
    chipsRef.current?.querySelectorAll<HTMLElement>('[data-group-id]').forEach((el) => {
      const id = el.dataset.groupId!;
      const rect = el.getBoundingClientRect();
      const old = positions.current.get(id);
      if (old && !reduced && el.animate && (old.x !== rect.x || old.y !== rect.y)) {
        el.animate([{ transform: `translate(${old.x - rect.x}px, ${old.y - rect.y}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      }
      next.set(id, rect);
    });
    positions.current = next;
  }, [preview, data.groups]);

  const clearSelection = () => { setPicked([]); setAnchor(null); setBulkError(''); };
  const changeFilter = (next: string | null) => { clearSelection(); setFilter(next); };
  const toggle = (id: string) => {
    setBulkError('');
    setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    setAnchor(id);
  };
  const selectRange = (id: string) => {
    const ids = visible.map((s) => s.id);
    const from = anchor ? ids.indexOf(anchor) : -1;
    if (from < 0) { toggle(id); return; }
    const to = ids.indexOf(id);
    setBulkError('');
    setPicked(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
  };
  const clickRow = (event: MouseEvent, session: Session) => {
    if (event.metaKey || event.ctrlKey) { toggle(session.id); return; }
    if (event.shiftKey) { selectRange(session.id); return; }
    clearSelection();
    // Switching sessions is not possible while another one is being captured.
    if (isCapturing && session.id !== activeId) return;
    void selectSession(session.id);
  };
  const listKeys = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); setBulkError(''); setPicked(visible.map((s) => s.id));
    } else if (event.key === 'Escape' && selecting) {
      event.preventDefault(); clearSelection();
    }
  };

  const open = (next: Dialog) => {
    setMenu(null); setFormError('');
    const id = 'id' in next ? next.id : null;
    const group = data.groups.find((g) => g.id === id);
    setName(next.kind === 'group' ? group?.name ?? '' : next.kind === 'rename' ? titleOf(next.id) : '');
    setTag(next.kind === 'group' ? group?.tag ?? '' : '');
    setDialog(next);
  };
  const move = async (ids: string[], target: string | null) => {
    await commit(moveSessions(data, ids, target));
    setNotice(`${ids.length === 1 ? 'Session' : sessionsWord(ids.length)} moved to ${groupName(target)}.`);
    if (ids.length > 1) clearSelection();
  };
  const safely = (action: () => void | Promise<void>) => {
    try { void action()?.catch((err: Error) => setError(err.message)); }
    catch (err) { setError((err as Error).message); }
  };
  const endDrag = () => { setDrag(null); setHover(null); setPreview(null); };
  const startDrag = (event: DragEvent, value: Drag) => {
    if ((event.target as HTMLElement).closest('.session__more, input') && value.kind === 'session') { event.preventDefault(); return; }
    setMenu(null); setDrag(value);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-skaz-navigation', JSON.stringify(value));
  };
  const overGroup = (event: DragEvent, target: string | null) => {
    if (!drag || (drag.kind === 'group' && target === null)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    if (drag.kind === 'session') { setHover(target ?? 'all'); return; }
    if (drag.id === target) return;
    const ids = preview ?? data.groups.map((g) => g.id);
    const from = ids.indexOf(drag.id); const to = ids.indexOf(target!);
    if (from < 0 || to < 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    // Cross the target midpoint before reflowing to avoid jitter at adjacent edges.
    if ((from < to && event.clientX < rect.x + rect.width / 2) || (from > to && event.clientX > rect.x + rect.width / 2)) return;
    const reordered = ids.filter((id) => id !== drag.id);
    reordered.splice(to, 0, drag.id); setPreview(reordered);
  };
  const drop = (event: DragEvent, target: string | null) => {
    if (!drag) return;
    event.preventDefault();
    safely(async () => {
      if (drag.kind === 'session') await move(drag.ids, target);
      else if (target !== null && preview) { await commit(reorderGroups(data, preview)); setNotice('Group order saved.'); }
    });
    endDrag();
  };
  // The capturing session is never part of a bulk delete; the dialog says so.
  const deletable = (ids: string[]) => ids.filter((id) => id !== capturingId);
  const deleteSelection = async (ids: string[]) => {
    const targets = deletable(ids);
    const result = await removeSessions(targets);
    if (result.failed.length) {
      const reasons = [...new Set(result.failed.map((f) => f.reason))].join(' ');
      setBulkError(`${result.failed.length} of ${targets.length} not deleted — ${reasons}`);
      setPicked(result.failed.map((f) => f.id));
    } else clearSelection();
    if (result.deleted.length) setNotice(`${sessionsWord(result.deleted.length)} deleted.`);
  };
  const save = async () => {
    if (!dialog || busy) return;
    setFormError(''); setBusy(true);
    try {
      if (dialog.kind === 'group' && dialog.moveSessions) {
        const created = updateGroup(data, null, name, tag);
        const group = created.groups.at(-1)!;
        await commit(moveSessions(created, dialog.moveSessions, group.id));
        setNotice(`${dialog.moveSessions.length === 1 ? 'Session' : sessionsWord(dialog.moveSessions.length)} moved to ${group.name}.`);
        if (dialog.moveSessions.length > 1) clearSelection();
      } else if (dialog.kind === 'group') await commit(updateGroup(data, dialog.id, name, tag));
      else if (dialog.kind === 'rename') {
        if (!name.trim()) throw new Error('Enter a session name.');
        await renameSession(dialog.id, name.trim());
      } else if (dialog.kind === 'delete-group') {
        await commit(deleteGroup(data, dialog.id));
        if (filter === dialog.id) changeFilter(null);
        setNotice('Group deleted. Sessions remain in All.');
      } else if (dialog.kind === 'delete-session') {
        if (dialog.id === useStore.getState().activeSessionId && ['recording', 'paused', 'processing'].includes(useStore.getState().recorderState)) {
          throw new Error('Stop recording before deleting this session.');
        }
        await removeSession(dialog.id);
        setNotice('Session deleted.');
      } else if (dialog.kind === 'delete-sessions') {
        await deleteSelection(dialog.ids);
      }
      setDialog(null);
    } catch (err) { setFormError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  // The original of a session imported from YouTube, for "Open original" in its
  // menu (UI-CLEANUP §1: no longer a strip over the transcript).
  const [originalLink, setOriginalLink] = useState<{ id: string; url: string | null } | null>(null);
  const menuSessionId = menu?.kind === 'session' ? menu.id : null;
  const menuImported = menuSessionId ? sessions.find((s) => s.id === menuSessionId)?.origin === 'import' : false;
  useEffect(() => {
    if (!menuSessionId || !menuImported) return undefined;
    let current = true;
    void new ApiClient(window.skaz).getImport(menuSessionId)
      .then((value) => { if (current) setOriginalLink({ id: menuSessionId, url: mediaSourceLink(value.source.video_id) }); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [menuSessionId, menuImported]);
  const menuItems = (): SessionMenuItem[] => {
    if (!menu) return [];
    if (menu.kind === 'group') return [
      { label: 'Edit name and tag', action: () => open({ kind: 'group', id: menu.id }) },
      { label: 'Delete group…', destructive: true, action: () => open({ kind: 'delete-group', id: menu.id }) },
    ];
    // A menu on one of several selected sessions acts on the whole selection.
    if (selected.length > 1 && selected.includes(menu.id)) {
      const ids = selected;
      return [
        { label: `Move ${sessionsWord(ids.length)}…`, action: () => open({ kind: 'move', ids }) },
        { label: 'Clear selection', action: clearSelection },
        { label: `Delete ${sessionsWord(ids.length)}…`, destructive: true, disabled: deletable(ids).length === 0,
          action: () => open({ kind: 'delete-sessions', ids }) },
      ];
    }
    const original = originalLink?.id === menu.id ? originalLink.url : null;
    return [
      // A safe https YouTube URL only (mediaSourceLink); window.open goes through
      // main's setWindowOpenHandler, which hands http(s) to the OS browser.
      ...(original ? [{ label: 'Open original', action: () => { window.open(original, '_blank', 'noreferrer'); } }] : []),
      { label: 'Rename', action: () => open({ kind: 'rename', id: menu.id }) },
      { label: 'Move to group…', action: () => open({ kind: 'move', ids: [menu.id] }) },
      ...(data.membership[menu.id] ? [{ label: 'Remove from group', action: () => safely(() => move([menu.id], null)) }] : []),
      { label: 'Select…', action: () => { setBulkError(''); setPicked([menu.id]); setAnchor(menu.id); } },
      { label: 'Delete session…', destructive: true, disabled: menu.id === activeId && isCapturing, action: () => open({ kind: 'delete-session', id: menu.id }) },
    ];
  };
  const bulkDeleteTargets = dialog?.kind === 'delete-sessions' ? deletable(dialog.ids) : [];
  const title = dialog?.kind === 'group'
    ? (dialog.moveSessions ? (dialog.moveSessions.length > 1 ? 'New group for these sessions' : 'New group for this session') : dialog.id ? 'Edit group' : 'Create group')
    : dialog?.kind === 'rename' ? 'Rename session'
      : dialog?.kind === 'move' ? (dialog.ids.length > 1 ? `Move ${sessionsWord(dialog.ids.length)} to group` : 'Move to group')
        : dialog?.kind === 'delete-group' ? 'Delete group?'
          : dialog?.kind === 'delete-sessions' ? `Delete ${sessionsWord(bulkDeleteTargets.length)}?` : 'Delete session?';
  const deleting = dialog?.kind === 'delete-group' || dialog?.kind === 'delete-session' || dialog?.kind === 'delete-sessions';

  return <>
    <div className="rail__group-tools"><span>Groups</span></div>
    {/* The tablist is display: contents so New group flows right after the last
        chip without being a (non-tab) child of the tablist. */}
    <div className="rail__chips">
    <div ref={chipsRef} className="rail__chips-tabs" role="tablist" aria-label="Session groups" onDragEnd={endDrag}>
      <button role="tab" aria-selected={filter === null} className={clsx('chip', 'chip--all', filter === null && 'chip--active', hover === 'all' && 'chip--drop')}
        onClick={() => changeFilter(null)} onDragOver={(e) => overGroup(e, null)} onDrop={(e) => drop(e, null)}
        onDragLeave={() => setHover(null)}>All <span className="chip__count">{sessions.length}</span></button>
      {groups.map((group) => <button key={group.id} data-group-id={group.id} role="tab" draggable aria-selected={filter === group.id}
        className={clsx('chip', filter === group.id && 'chip--active', hover === group.id && 'chip--drop', drag?.kind === 'group' && drag.id === group.id && 'chip--dragging')}
        style={{ '--chip-color': `var(--group-${tagColorIndex(group.id) + 1})` } as CSSProperties}
        title={`${group.name}${group.tag ? ` #${group.tag}` : ''} · Right-click to edit; drag to reorder`}
        onClick={() => { if (!drag) changeFilter(group.id); }}
        onContextMenu={(e) => { e.preventDefault(); e.currentTarget.focus(); setMenu({ kind: 'group', id: group.id, anchor: e.currentTarget.getBoundingClientRect() }); }}
        onKeyDown={(e) => {
          if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
            e.preventDefault(); setMenu({ kind: 'group', id: group.id, anchor: e.currentTarget.getBoundingClientRect() });
          }
          if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault(); const ids = data.groups.map((g) => g.id); const from = ids.indexOf(group.id);
            const to = from + (e.key === 'ArrowLeft' ? -1 : 1);
            if (to >= 0 && to < ids.length) { ids.splice(from, 1); ids.splice(to, 0, group.id); safely(() => commit(reorderGroups(data, ids))); }
          }
        }}
        onDragStart={(e) => startDrag(e, { kind: 'group', id: group.id })}
        onDragOver={(e) => overGroup(e, group.id)} onDrop={(e) => drop(e, group.id)} onDragLeave={() => setHover(null)}>
        {/* Spaces between the parts keep the tab's accessible name readable ("Study #uni 1");
            whitespace between inline-flex items is not rendered, so the chip looks the same. */}
        <span className="chip__dot" aria-hidden="true" /><span className="chip__label">{group.name}</span>
        {group.tag && <>{' '}<span className="chip__tag">#{group.tag}</span></>}
        {' '}<span className="chip__count">{sessions.filter((s) => data.membership[s.id] === group.id).length}</span>
      </button>)}
    </div>
    <button type="button" className="chip chip--new" title="Create a group of sessions" onClick={() => open({ kind: 'group', id: null })}>
      <Icon name="plus" size={12} /><span className="chip__label">New group</span>
    </button>
    </div>
    {error && <p role="alert" className="rail__notice">{error}</p>}
    <span className="session-navigation-announcement" role="status">{notice}</span>
    {!visible.length ? <p className="rail__empty">{sessions.length ? 'No sessions in this group.' : 'No sessions yet. Start one to begin listening.'}</p>
      : <ul ref={listRef} className={clsx('rail__list', selecting && 'rail__list--selecting')} aria-label="Saved sessions"
        aria-multiselectable={selecting || undefined} onKeyDown={listKeys}>
        {visible.map((session) => {
          const isPicked = selected.includes(session.id);
          const locked = isCapturing && session.id !== activeId;
          return <li key={session.id}
            className={clsx('session', session.id === activeId && 'session--active', isPicked && 'session--picked',
              drag?.kind === 'session' && drag.ids.includes(session.id) && 'session--dragging')}
            draggable onDragStart={(e) => startDrag(e, { kind: 'session', ids: isPicked ? selected : [session.id] })} onDragEnd={endDrag}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'session', id: session.id, anchor: e.currentTarget.getBoundingClientRect() }); }}>
            {selecting && <input type="checkbox" className="session__check" aria-label={`Select ${session.title}`}
              checked={isPicked} onChange={() => toggle(session.id)} />}
            {/* aria-disabled, not disabled: while capturing, other sessions cannot be
                opened but can still be ⌘-clicked into a selection. */}
            <button className="session__select" aria-current={session.id === activeId} aria-disabled={locked || undefined}
              onClick={(e) => clickRow(e, session)} title={session.title}>
              <span className="session__marker" aria-hidden="true"><span className={clsx('session__dot', `session__dot--${shownStatus(session, capturingId)}`)} /></span>
              <span className="session__body"><span className="session__name">{stripTags(session.title)}</span><span className="session__meta tabular">{imports[session.id] ? 'Importing…' : statusLabel[shownStatus(session, capturingId)]}
                {/* A note is still being written for this session (docs/NOTES-POLISH-SPEC.md §4). */}
                {noteGenerations[session.id]?.status === 'running' && <span className="session__notes-busy" role="status" aria-label="Notes are being generated" title="Notes are being generated"><span className="session__notes-spinner" aria-hidden="true" />Notes…</span>}</span></span>
            </button>
            <button className="session__more" aria-label={`Actions for ${session.title}`} title="Session actions" aria-haspopup="menu" aria-expanded={menu?.kind === 'session' && menu.id === session.id}
              onClick={(e) => setMenu({ kind: 'session', id: session.id, anchor: e.currentTarget.getBoundingClientRect() })}><Icon name="more" size={16} /></button>
          </li>;
        })}
      </ul>}
    {selecting && <div className="rail__selection" role="toolbar" aria-label="Selected sessions" onKeyDown={listKeys}>
      {bulkError && <p role="alert" className="rail__selection-error">{bulkError}</p>}
      <span className="rail__selection-count tabular">{selected.length} selected</span>
      <button type="button" className="rail__selection-btn" onClick={() => open({ kind: 'move', ids: selected })}>Move…</button>
      <button type="button" className="rail__selection-btn rail__selection-btn--danger" disabled={deletable(selected).length === 0}
        title={deletable(selected).length === 0 ? 'Stop recording before deleting this session.' : undefined}
        onClick={() => open({ kind: 'delete-sessions', ids: selected })}>Delete…</button>
      <button type="button" className="rail__selection-clear" aria-label="Clear selection" title="Clear selection (Esc)" onClick={clearSelection}>
        <Icon name="close" size={14} />
      </button>
    </div>}
    {menu && <SessionMenu label={menu.kind === 'group' ? 'Group actions' : 'Session actions'} anchor={menu.anchor} owner={chipsRef} items={menuItems()} onClose={() => setMenu(null)} />}
    {dialog && <SessionDialog key={dialog.kind} title={title} onClose={() => setDialog(null)} busy={busy}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {(dialog.kind === 'group' || dialog.kind === 'rename') && <label className="session-dialog__field">{dialog.kind === 'group' ? 'Group name' : 'Session name'}
          <input value={name} maxLength={dialog.kind === 'group' ? 60 : 200} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </label>}
        {dialog.kind === 'group' && <label className="session-dialog__field">Tag (optional)
          <input value={tag} aria-label="Tag (optional)" aria-describedby="group-tag-help" placeholder="#study" maxLength={33} onChange={(e) => setTag(e.target.value)} disabled={busy} />
          <span id="group-tag-help">One short label, separate from the group name.</span>
        </label>}
        {dialog.kind === 'move' && <div className="session-dialog__destinations">
          {[{ id: null, name: 'All — no group', tag: '' }, ...data.groups].map((g) => <button type="button" key={g.id ?? 'all'}
            disabled={busy || dialog.ids.every((id) => (data.membership[id] ?? null) === g.id)}
            onClick={() => { setBusy(true); void move(dialog.ids, g.id).then(() => setDialog(null),
              (err: Error) => setFormError(err.message)).finally(() => setBusy(false)); }}>
            {g.name} {g.tag && <span>#{g.tag}</span>}
          </button>)}
          <button type="button" className="session-dialog__new-group" disabled={busy}
            onClick={() => { const ids = dialog.ids; setFormError(''); setName(''); setTag(''); setDialog({ kind: 'group', id: null, moveSessions: ids }); }}>
            <Icon name="plus" size={13} /> New group…
          </button>
        </div>}
        {dialog.kind === 'delete-group' && <p>Delete “{groupName(dialog.id)}”? Its sessions will remain in All.</p>}
        {dialog.kind === 'delete-session' && <p>Delete “{titleOf(dialog.id)}” and its transcript and notes? This cannot be undone.</p>}
        {dialog.kind === 'delete-sessions' && <>
          <p>Delete {sessionsWord(bulkDeleteTargets.length)} and their transcripts and notes? This cannot be undone.</p>
          <ul className="session-dialog__names">
            {bulkDeleteTargets.slice(0, NAMED_IN_CONFIRMATION).map((id) => <li key={id}>{stripTags(titleOf(id))}</li>)}
            {bulkDeleteTargets.length > NAMED_IN_CONFIRMATION && <li>…and {bulkDeleteTargets.length - NAMED_IN_CONFIRMATION} more</li>}
          </ul>
          {capturingId && dialog.ids.includes(capturingId) && <p>“{stripTags(titleOf(capturingId))}” is recording and will be kept.</p>}
        </>}
        {formError && <p role="alert" className="session-dialog__error">{formError}</p>}
        <div className="session-dialog__actions">
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
          {dialog.kind !== 'move' && <button className="btn btn--primary" type="submit"
            disabled={busy || ((dialog.kind === 'group' || dialog.kind === 'rename') && !name.trim()) || (dialog.kind === 'delete-sessions' && bulkDeleteTargets.length === 0)}>
            {busy ? 'Saving…' : deleting ? 'Delete' : dialog.kind === 'group' && dialog.moveSessions ? 'Create and move' : dialog.kind === 'group' && !dialog.id ? 'Create' : 'Save'}
          </button>}
        </div>
      </form>
    </SessionDialog>}
  </>;
}
