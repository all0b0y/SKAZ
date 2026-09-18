import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { deleteGroup, moveSession, reorderGroups, updateGroup } from '../../lib/sessionGroups';
import { stripTags, tagColorIndex } from '../../lib/sessionTags';
import { Icon } from '../ui/Icon';
import { SessionDialog, SessionMenu, type SessionMenuItem } from './SessionOverlays';
import { useSessionGroups } from './useSessionGroups';
import './sessionNavigator.css';

type Dialog = { kind: 'group'; id: string | null } | { kind: 'rename' | 'move' | 'delete-session' | 'delete-group'; id: string };
type Drag = { kind: 'session' | 'group'; id: string };
const statusLabel = { recording: 'Recording', paused: 'Paused', stopped: 'Saved' };

export function SessionNavigator() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const recorderState = useStore((s) => s.recorderState);
  const selectSession = useStore((s) => s.selectSession);
  const renameSession = useStore((s) => s.renameSession);
  const removeSession = useStore((s) => s.removeSession);
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
  const chipsRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, DOMRect>());
  const isCapturing = ['recording', 'paused', 'processing'].includes(recorderState);
  const groups = preview ? preview.map((id) => data.groups.find((g) => g.id === id)!).filter(Boolean) : data.groups;
  const visible = filter ? sessions.filter((s) => data.membership[s.id] === filter) : sessions;
  const groupName = (id: string | null) => data.groups.find((g) => g.id === id)?.name ?? 'All';

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

  const open = (next: Dialog) => {
    setMenu(null); setFormError('');
    const group = data.groups.find((g) => g.id === next.id);
    setName(next.kind === 'group' ? group?.name ?? '' : next.kind === 'rename' ? sessions.find((s) => s.id === next.id)?.title ?? '' : '');
    setTag(next.kind === 'group' ? group?.tag ?? '' : '');
    setDialog(next);
  };
  const move = async (id: string, target: string | null) => {
    await commit(moveSession(data, id, target));
    setNotice(`Session moved to ${groupName(target)}.`);
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
      if (drag.kind === 'session') await move(drag.id, target);
      else if (target !== null && preview) { await commit(reorderGroups(data, preview)); setNotice('Group order saved.'); }
    });
    endDrag();
  };
  const save = async () => {
    if (!dialog || busy) return;
    setFormError(''); setBusy(true);
    try {
      if (dialog.kind === 'group') await commit(updateGroup(data, dialog.id, name, tag));
      else if (dialog.kind === 'rename') {
        if (!name.trim()) throw new Error('Enter a session name.');
        await renameSession(dialog.id, name.trim());
      } else if (dialog.kind === 'delete-group') {
        await commit(deleteGroup(data, dialog.id));
        if (filter === dialog.id) setFilter(null);
        setNotice('Group deleted. Sessions remain in All.');
      } else if (dialog.kind === 'delete-session') {
        if (dialog.id === useStore.getState().activeSessionId && ['recording', 'paused', 'processing'].includes(useStore.getState().recorderState)) {
          throw new Error('Stop recording before deleting this session.');
        }
        await removeSession(dialog.id);
        setNotice('Session deleted.');
      }
      setDialog(null);
    } catch (err) { setFormError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const menuItems = (): SessionMenuItem[] => {
    if (!menu) return [];
    if (menu.kind === 'group') return [
      { label: 'Edit name and tag', action: () => open({ kind: 'group', id: menu.id }) },
      { label: 'Delete group…', destructive: true, action: () => open({ kind: 'delete-group', id: menu.id }) },
    ];
    return [
      { label: 'Rename', action: () => open({ kind: 'rename', id: menu.id }) },
      { label: 'Move to group…', action: () => open({ kind: 'move', id: menu.id }) },
      ...(data.membership[menu.id] ? [{ label: 'Remove from group', action: () => safely(() => move(menu.id, null)) }] : []),
      { label: 'Delete session…', destructive: true, disabled: menu.id === activeId && isCapturing, action: () => open({ kind: 'delete-session', id: menu.id }) },
    ];
  };
  const title = dialog?.kind === 'group' ? (dialog.id ? 'Edit group' : 'Create group')
    : dialog?.kind === 'rename' ? 'Rename session' : dialog?.kind === 'move' ? 'Move to group'
      : dialog?.kind === 'delete-group' ? 'Delete group?' : 'Delete session?';
  const deleting = dialog?.kind === 'delete-group' || dialog?.kind === 'delete-session';

  return <>
    <div className="rail__group-tools">
      <span>Groups</span><button className="rail__foot-btn" aria-label="Create group" title="Create group" onClick={() => open({ kind: 'group', id: null })}><Icon name="plus" size={15} /></button>
    </div>
    <div ref={chipsRef} className="rail__chips" role="tablist" aria-label="Session groups" onDragEnd={endDrag}>
      <button role="tab" aria-selected={filter === null} className={clsx('chip', 'chip--all', filter === null && 'chip--active', hover === 'all' && 'chip--drop')}
        onClick={() => setFilter(null)} onDragOver={(e) => overGroup(e, null)} onDrop={(e) => drop(e, null)}
        onDragLeave={() => setHover(null)}>All <span className="chip__count">{sessions.length}</span></button>
      {groups.map((group) => <button key={group.id} data-group-id={group.id} role="tab" draggable aria-selected={filter === group.id}
        className={clsx('chip', filter === group.id && 'chip--active', hover === group.id && 'chip--drop', drag?.kind === 'group' && drag.id === group.id && 'chip--dragging')}
        style={{ '--chip-color': `var(--group-${tagColorIndex(group.id) + 1})` } as CSSProperties}
        title={`${group.name}${group.tag ? ` #${group.tag}` : ''} · Right-click to edit; drag to reorder`}
        onClick={() => { if (!drag) setFilter(group.id); }}
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
        <span className="chip__dot" aria-hidden="true" /><span className="chip__label">{group.name}</span>
        {group.tag && <span className="chip__tag">#{group.tag}</span>}
        <span className="chip__count">{sessions.filter((s) => data.membership[s.id] === group.id).length}</span>
      </button>)}
    </div>
    {error && <p role="alert" className="rail__notice">{error}</p>}
    <span className="session-navigation-announcement" role="status">{notice}</span>
    {!visible.length ? <p className="rail__empty">{sessions.length ? 'No sessions in this group.' : 'No sessions yet. Start one to begin listening.'}</p>
      : <ul className="rail__list" aria-label="Saved sessions">
        {visible.map((session) => <li key={session.id} className={clsx('session', session.id === activeId && 'session--active', drag?.kind === 'session' && drag.id === session.id && 'session--dragging')}
          draggable onDragStart={(e) => startDrag(e, { kind: 'session', id: session.id })} onDragEnd={endDrag}>
          <button className="session__select" aria-current={session.id === activeId} disabled={isCapturing && session.id !== activeId}
            onClick={() => void selectSession(session.id)} title={session.title}>
            <span className="session__marker" aria-hidden="true"><span className={clsx('session__dot', `session__dot--${session.status}`)} /></span>
            <span className="session__body"><span className="session__name">{stripTags(session.title)}</span><span className="session__meta tabular">{statusLabel[session.status]}</span></span>
          </button>
          <button className="session__more" aria-label={`Actions for ${session.title}`} title="Session actions" aria-haspopup="menu" aria-expanded={menu?.kind === 'session' && menu.id === session.id}
            onClick={(e) => setMenu({ kind: 'session', id: session.id, anchor: e.currentTarget.getBoundingClientRect() })}><Icon name="more" size={16} /></button>
        </li>)}
      </ul>}
    {menu && <SessionMenu label={menu.kind === 'group' ? 'Group actions' : 'Session actions'} anchor={menu.anchor} items={menuItems()} onClose={() => setMenu(null)} />}
    {dialog && <SessionDialog title={title} onClose={() => setDialog(null)} busy={busy}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {(dialog.kind === 'group' || dialog.kind === 'rename') && <label className="session-dialog__field">{dialog.kind === 'group' ? 'Group name' : 'Session name'}
          <input value={name} maxLength={dialog.kind === 'group' ? 60 : 200} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </label>}
        {dialog.kind === 'group' && <label className="session-dialog__field">Tag (optional)
          <input value={tag} aria-label="Tag (optional)" aria-describedby="group-tag-help" placeholder="#study" maxLength={33} onChange={(e) => setTag(e.target.value)} disabled={busy} />
          <span id="group-tag-help">One short label, separate from the group name.</span>
        </label>}
        {dialog.kind === 'move' && <div className="session-dialog__destinations">
          {!data.groups.length && <p>Create a group with the + button next to Groups first.</p>}
          {[{ id: null, name: 'All — no group', tag: '' }, ...data.groups].map((g) => <button type="button" key={g.id ?? 'all'}
            disabled={busy || (data.membership[dialog.id] ?? null) === g.id}
            onClick={() => { setBusy(true); void move(dialog.id!, g.id).then(() => setDialog(null),
              (err: Error) => setFormError(err.message)).finally(() => setBusy(false)); }}>
            {g.name} {g.tag && <span>#{g.tag}</span>}
          </button>)}
        </div>}
        {dialog.kind === 'delete-group' && <p>Delete “{groupName(dialog.id)}”? Its sessions will remain in All.</p>}
        {dialog.kind === 'delete-session' && <p>Delete “{sessions.find((s) => s.id === dialog.id)?.title}” and its audio, transcript and notes? This cannot be undone.</p>}
        {formError && <p role="alert" className="session-dialog__error">{formError}</p>}
        <div className="session-dialog__actions">
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
          {dialog.kind !== 'move' && <button className="btn btn--primary" type="submit" disabled={busy || ((dialog.kind === 'group' || dialog.kind === 'rename') && !name.trim())}>
            {busy ? 'Saving…' : deleting ? 'Delete' : dialog.kind === 'group' && !dialog.id ? 'Create' : 'Save'}
          </button>}
        </div>
      </form>
    </SessionDialog>}
  </>;
}
