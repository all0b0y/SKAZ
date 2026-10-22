import { useId, useRef, useState } from 'react';
import type { KbChatSummary } from '../../api/kb/types.gen';
import { Button, IconButton, Menu, Modal } from '../ui';
import { Popover } from '../ui/Popover';
import { useServices } from '../state/context';
import { useOpenDocument } from '../state/document';
import { savedText } from './saved';

/**
 * Chat ⋯ menu (v3): pin, rename, export .md, save to wiki as an analysis, delete. Every action
 * reports its real outcome through `onNotice` (a status line), never silently.
 */
export function ChatMenu({ chat, onNotice, onRename, size = 'md' }: {
  chat: KbChatSummary;
  onNotice: (text: string, ms?: number) => void;
  /** Inline rename (chat header); without it a small rename field opens here. */
  onRename?: () => void;
  size?: 'sm' | 'md';
}) {
  const { chats, bridge } = useServices();
  const open = useOpenDocument();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const exportChat = async () => {
    const res = await chats.getState().exportChat(chat.id);
    if (!res.ok) { onNotice(`Couldn’t export: ${res.error}`); return; }
    if (!bridge.saveTextFile) { onNotice('Saving files isn’t available in this window.'); return; }
    const saved = await bridge.saveTextFile({ suggested_name: res.value.file_name, text: res.value.markdown });
    onNotice(saved.saved ? `Exported to ${saved.path ?? res.value.file_name}` : 'Export cancelled.');
  };
  const saveToWiki = async () => {
    const res = await chats.getState().saveChat(chat.id);
    if (!res.ok) { onNotice(`Couldn’t save to the wiki: ${res.error}`); return; }
    onNotice(savedText(res.value), res.value.warning ? 10000 : undefined);
    open({ type: 'page', id: res.value.id });
  };

  return (
    <>
      <IconButton ref={anchor} icon="more" label={`More for “${chat.title}”`} size={size} aria-haspopup="menu" aria-expanded={menu}
        onClick={() => setMenu((v) => !v)} />
      <Menu open={menu} onClose={() => setMenu(false)} anchorRef={anchor} label="Chat actions" items={[
        {
          id: 'pin', label: chat.pinned ? 'Unpin' : 'Pin', icon: chat.pinned ? 'unpin' : 'pin',
          onSelect: async () => { const r = await chats.getState().setPinned(chat.id, !chat.pinned); if (!r.ok) onNotice(r.error); },
        },
        { id: 'rename', label: 'Rename', icon: 'pencil', onSelect: () => (onRename ? onRename() : setRenaming(true)) },
        { id: 'export', label: 'Export as .md', icon: 'export', onSelect: () => void exportChat() },
        { id: 'save', label: 'Save to wiki as analysis', icon: 'saveWiki', onSelect: () => void saveToWiki() },
        { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => setConfirm(true) },
      ]} />
      {!onRename && (
        <Popover open={renaming} onClose={() => setRenaming(false)} anchorRef={anchor} label="Rename chat" placement="bottom-end" width={280}>
          <RenameForm title={chat.title} onCancel={() => setRenaming(false)} onSave={async (title) => {
            const r = await chats.getState().rename(chat.id, title);
            if (!r.ok) return r.error;
            setRenaming(false);
            return null;
          }} />
        </Popover>
      )}
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Delete this chat?" className="kb-confirm" testId="confirm-delete-chat">
        <div className="kb-confirm__body">
          <p>“{chat.title}” and its answers will be deleted. Pages you saved to the wiki stay.</p>
        </div>
        <footer className="kb-confirm__foot">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={async () => {
            setBusy(true);
            const r = await chats.getState().remove(chat.id);
            setBusy(false);
            setConfirm(false);
            onNotice(r.ok ? 'Chat deleted.' : `Couldn’t delete: ${r.error}`);
          }}>Delete</Button>
        </footer>
      </Modal>
    </>
  );
}

export function RenameForm({ title, onSave, onCancel, label = 'Chat name' }: {
  title: string; onSave: (title: string) => Promise<string | null>; onCancel: () => void; label?: string;
}) {
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  /** Esc already decided; the blur that follows must not save. */
  const settled = useRef(false);
  const commit = async (fromBlur: boolean) => {
    if (settled.current) return;
    const next = value.trim();
    // Leaving the field (QA D7) saves a real change and drops an empty or unchanged one.
    if (!next) { if (fromBlur) { settled.current = true; onCancel(); } else setError('Enter a name.'); return; }
    if (next === title) { settled.current = true; onCancel(); return; }
    settled.current = true;
    const problem = await onSave(next);
    settled.current = problem === null;
    setError(problem);
  };
  return (
    <form className="kb-rename" onSubmit={(e) => { e.preventDefault(); void commit(false); }}>
      <label htmlFor={id} className="kb-visually-hidden">{label}</label>
      <input id={id} className="kb-rename__input" value={value} autoFocus onChange={(e) => { setValue(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settled.current = true; onCancel(); } }}
        onBlur={() => void commit(true)}
        aria-invalid={error ? true : undefined} />
      {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
    </form>
  );
}
