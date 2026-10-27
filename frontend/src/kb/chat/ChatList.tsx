import { useEffect, useId, useState } from 'react';
import type { KbChatSummary } from '../../api/kb/types.gen';
import { Banner, Button, EmptyState, Icon, IconButton, Segmented, Spinner, useIconPlay } from '../ui';
import { clockOrDate, dayBucket, groupBy } from '../ui/time';
import { ActiveTab } from '../ui/ActiveTab';
import { useChats, useLibrary, useServices, useUi } from '../state/context';
import { ChatMenu } from './ChatMenu';
import { useFolderTone } from './parts';
import { useChatSelection } from './chatBatch';
import { SelectionCheckbox } from '../ui/listSelection';
import { isWaitingForUser } from '../api/permissions';
import { NEW_CHAT_KEY, sideChats } from './sideOrder';
import { ChatMark, WaitingMark } from './ChatMark';

export { WaitingMark };

function useOpenChat() {
  const { chats, ui } = useServices();
  return (id: string | null) => {
    chats.getState().open(id);
    ui.getState().showCenter('chat');
  };
}

/**
 * The one «open chat» condition (FIX1 R5): the row key of the chat the centre shows — a chat id, or
 * {@link NEW_CHAT_KEY} for a new one — or null with All chats / All materials or an expanded
 * document in the centre. It drives the bridge, the row's `is-current` class, `aria-current` and
 * the mark (the open chat shows none, ChatMark.tsx).
 */
export function useOpenChatKey(): string | null {
  const currentId = useChats((s) => s.currentId);
  const center = useUi((s) => s.center);
  const docInCenter = useUi((s) => s.right !== null && s.docExpanded);
  return center === 'chat' && !docInCenter ? currentId ?? NEW_CHAT_KEY : null;
}

/** Left panel → Chats: new chat, pinned, by date (a few), "All chats · N" (decision v2/v16). */
export function ChatList() {
  const list = useChats((s) => s.list);
  const load = useChats((s) => s.listLoad);
  const error = useChats((s) => s.listError);
  const center = useUi((s) => s.center);
  const { chats } = useServices();
  const openChat = useOpenChat();
  const showCenter = useUi((s) => s.showCenter);
  const [newPlay, replayNew] = useIconPlay();

  const { pinned, rest, groups } = sideChats(list);
  const { sel, overlays } = useChatSelection({ chats: [...pinned, ...rest], onOpen: (id) => openChat(id) });
  // The open chat's row runs into its window (decision 24 «Chats»): one tab for the whole list.
  // With All chats / All materials (or an expanded document) in the centre no row is open.
  const openKey = useOpenChatKey();
  const newOpen = openKey === NEW_CHAT_KEY;

  const row = (c: KbChatSummary) => {
    const current = openKey === c.id;
    return (
      <li key={c.id} {...sel.rowProps(c.id)}>
        <div role="gridcell">
          <button type="button" className={`kb-row kb-row--tabbed kb-chatrow${current ? ' is-current' : ''}${c.unread ? ' is-unread' : ''}`}
            data-tab-key={c.id} aria-current={current ? 'page' : undefined} onClick={() => openChat(c.id)}>
            <SelectionCheckbox checked={sel.selected.has(c.id)} />
            {c.pinned && <Icon name="pin" size={14} className="kb-row__icon" />}
            <span className="kb-row__text">{c.title}</span>
            <ChatMark chat={c} current={current} />
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className="kb-side__scroll kb-tabhost" {...sel.listProps}>
      <ActiveTab host={sel.listRef} activeKey={openKey} variant="bridge" />
      <button type="button" className={`kb-row kb-row--tabbed kb-row--action${newOpen ? ' is-current' : ''}`}
        data-tab-key={NEW_CHAT_KEY} aria-current={newOpen ? 'page' : undefined} onClick={() => { replayNew(); openChat(null); }}>
        <Icon name="newChat" size={16} className="kb-row__icon" play={newPlay} />
        <span className="kb-row__text">New chat</span>
      </button>
      {load === 'loading' && list.length === 0 && <div className="kb-side__wait"><Spinner label="Loading chats" size="sm" /></div>}
      {load === 'error' && list.length === 0 && (
        <div className="kb-side__pad">
          <Banner tone="error" title="Chats couldn’t be loaded."
            actions={<Button size="sm" icon="retry" onClick={() => void chats.getState().loadList()}>Try again</Button>}>
            {error}
          </Banner>
        </div>
      )}
      {load === 'ready' && list.length === 0 && (
        <EmptyState icon="chats" title="No chats yet" compact field>Ask your first question in the field below.</EmptyState>
      )}
      {pinned.length > 0 && (
        <section aria-label="Pinned">
          <h3 className="kb-subhead"><span className="kb-subhead__text">Pinned</span></h3>
          <ul className="kb-list" {...sel.gridProps} aria-label="Pinned">{pinned.map(row)}</ul>
        </section>
      )}
      {groups.map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h3 className="kb-subhead"><span className="kb-subhead__text">{g.label}</span></h3>
          <ul className="kb-list" {...sel.gridProps} aria-label={g.label}>{g.items.map(row)}</ul>
        </section>
      ))}
      {list.length > 0 && (
        <button type="button" className={`kb-row kb-row--more${center === 'allChats' ? ' is-current' : ''}`}
          onClick={() => showCenter('allChats')} aria-current={center === 'allChats' ? 'page' : undefined}>
          <span className="kb-row__text">All chats · {list.length}</span>
        </button>
      )}
      {overlays}
    </div>
  );
}

type Filter = 'all' | 'pinned' | 'recording';

/** "All chats" over the whole centre (v16): search, filter, folder, groups by date, ⋯ per row. */
export function AllChats() {
  const { client } = useServices();
  const openChat = useOpenChat();
  const showCenter = useUi((s) => s.showCenter);
  const [newPlay, replayNew] = useIconPlay();
  const total = useChats((s) => s.list.length);
  const listVersion = useChats((s) => s.list);
  const folders = useLibrary((s) => s.folders);
  const tone = useFolderTone();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [folder, setFolder] = useState('');
  const [rows, setRows] = useState<KbChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchId = useId();
  const folderId = useId();

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      client.call('GET /kb/chats', { query: { q: q.trim() || undefined, filter, folder_id: folder || undefined } }).then(
        (list) => { if (live) { setRows(list); setError(null); } },
        (e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Chats couldn’t be loaded.'); },
      );
    }, q ? 150 : 0);
    return () => { live = false; window.clearTimeout(t); };
  }, [client, q, filter, folder, listVersion]);

  const groups = groupBy(rows ?? [], (c) => dayBucket(c.updated_at));
  // 0.3.1 F4: the same selection as the side panel, with labelled actions (there is room here).
  const { sel, overlays } = useChatSelection({
    chats: groups.flatMap((g) => g.items), onOpen: (id) => openChat(id), variant: 'full', resetKey: `${q}\n${filter}\n${folder}`,
  });
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name;

  return (
    <section className="kb-center kb-allchats" data-pane="center" aria-label="All chats">
      <header className="kb-head">
        <h1 className="kb-head__title">All chats <span className="kb-head__count">{total}</span></h1>
        <span className="kb-head__spacer" />
        <Button size="sm" variant="fill" icon="newChat" iconPlay={newPlay}
          onClick={() => { replayNew(); openChat(null); }}>New chat</Button>
        <IconButton icon="close" label="Back to the chat" onClick={() => showCenter('chat')} />
      </header>
      <div className="kb-allchats__tools">
        <div className="kb-searchfield">
          <Icon name="search" size={14} />
          <label htmlFor={searchId} className="kb-visually-hidden">Find in chats</label>
          <input id={searchId} type="search" placeholder="Find in chats…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>
        <Segmented<Filter> label="Show" size="sm" value={filter} onChange={setFilter}
          options={[{ value: 'all', label: 'All' }, { value: 'pinned', label: 'Pinned' }, { value: 'recording', label: 'During recording' }]} />
        <span className="kb-head__spacer" />
        {/* Label and select wrap together, never apart (QA D16). */}
        <span className="kb-allchats__folder" data-testid="allchats-folder">
          <label htmlFor={folderId} className="kb-allchats__folder-label">Folder</label>
          <span className="kb-select">
            <select id={folderId} value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">All</option>
              {folders.filter((f) => !f.system).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <Icon name="chevronDown" size={12} className="kb-select__chev" />
          </span>
        </span>
      </div>
      {notice && <p className="kb-notice" role="status">{notice}</p>}
      <div className="kb-allchats__body" {...sel.listProps}>
        {error && <Banner tone="error" title="Chats couldn’t be loaded.">{error}</Banner>}
        {rows === null && !error && <div className="kb-chat__wait"><Spinner label="Loading chats" /></div>}
        {rows?.length === 0 && <EmptyState icon="chats" title={q ? `No chats match “${q.trim()}”` : 'No chats here'} compact />}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label} className="kb-allchats__group">
            <h2 className="kb-subhead"><span className="kb-subhead__text">{g.label}</span></h2>
            <ul className="kb-allchats__list" {...sel.gridProps} aria-label={g.label}>
              {g.items.map((c) => (
                <li key={c.id} className="kb-allchats__row" {...sel.rowProps(c.id)}>
                  <SelectionCheckbox checked={sel.selected.has(c.id)} />
                  <button type="button" className="kb-allchats__main" onClick={() => openChat(c.id)}>
                    <span className="kb-allchats__title">{c.pinned && <Icon name="pin" size={13} />}{c.title}</span>
                    <span className="kb-allchats__preview">{c.last_preview}</span>
                  </button>
                  <span className="kb-allchats__tags">
                    {isWaitingForUser(c) && <WaitingMark />}
                    {c.recording_material_id && <span className="kb-tag kb-tag--static"><Icon name="mic" size={12} />recording</span>}
                    {c.folder_ids.slice(0, 2).map((id) => folderName(id) && (
                      <span key={id} className="kb-tag kb-tag--static"><i className={`kb-fdot kb-fdot--${tone(id)}`} aria-hidden="true" />{folderName(id)}</span>
                    ))}
                  </span>
                  <span className="kb-allchats__time">{clockOrDate(c.updated_at)}</span>
                  <span data-sel-ignore><ChatMenu chat={c} size="sm" onNotice={setNotice} /></span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {overlays}
      </div>
    </section>
  );
}
