import { useState, type ReactNode } from 'react';
import type { KbChatSummary } from '../../api/kb/types.gen';
import { useServices } from '../state/context';
import { useExportItems } from '../document/exportItems';
import {
  BatchDeleteDialog, SelectionBar, ShortcutsPopover, countOf, namesList, resultText, useListSelection,
  type BatchResult, type ListSelection, type SelectionAction,
} from '../ui/listSelection';

/** One chat action as a batch step: ActionResult → throw, so `runOneByOne`-style results keep the reason. */
async function each(ids: readonly string[], fn: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>): Promise<BatchResult> {
  const out: BatchResult = { done: [], skipped: [] };
  for (const id of ids) {
    const r = await fn(id);
    if (r.ok) out.done.push(id); else out.skipped.push({ id, reason: r.error });
  }
  return out;
}

/**
 * Chats in the side panel, several at once (0.3.1 F4, mockup lib-v2 «Chats»): Pin, Export .md,
 * Delete; ⋯ Unpin, Mark as read, Save to wiki as analyses. Selecting never opens a chat.
 */
export function useChatSelection({ chats: list, onOpen, variant = 'compact', resetKey }: {
  chats: ReadonlyArray<KbChatSummary>;
  onOpen: (id: string) => void;
  /** The side panel is narrow (icons); "All chats" over the centre has room for labels. */
  variant?: 'full' | 'compact';
  /** Another search, filter or folder: the selection starts over. */
  resetKey?: unknown;
}): { sel: ListSelection; overlays: ReactNode } {
  const { chats, ui } = useServices();
  const exp = useExportItems();
  const exportMd = exp.run ? (picked: KbChatSummary[]) => { exp.run!(picked.map((c) => ({ type: 'chat' as const, id: c.id }))); } : null;
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const byId = new Map(list.map((c) => [c.id, c]));
  const pick = (ids: readonly string[]) => ids.map((id) => byId.get(id)).filter((c): c is KbChatSummary => Boolean(c));
  const sel = useListSelection({
    ids: list.map((c) => c.id),
    onOpen,
    onDelete: (ids) => setDeleteIds(ids),
    onExport: exportMd ? (ids) => exportMd(pick(ids)) : undefined,
    resetKey,
  });
  const toast = (text: string, res: BatchResult, undo?: () => void) => ui.getState().showToast({
    text, tone: res.skipped.length ? 'problem' : 'done', action: undo && res.done.length ? { label: 'Undo', run: undo } : undefined,
  });

  const setPinned = async (ids: string[], pinned: boolean, withUndo = true) => {
    // From the store, not this render: Undo runs after the list has changed.
    const todo = chats.getState().list.filter((c) => ids.includes(c.id) && c.pinned !== pinned).map((c) => c.id);
    sel.clear();
    if (!todo.length) { ui.getState().showToast({ text: pinned ? 'Already pinned' : 'None of them is pinned' }); return; }
    const res = await each(todo, (id) => chats.getState().setPinned(id, pinned));
    const verb = pinned ? 'Pinned' : 'Unpinned';
    toast(res.skipped.length ? resultText(verb, res, 'chat') : `${verb} ${countOf(res.done.length, 'chat')}`, res,
      withUndo ? () => void setPinned(res.done, !pinned, false) : undefined);
  };
  const markRead = async (ids: string[]) => {
    const todo = pick(ids).filter((c) => c.unread).map((c) => c.id);
    sel.clear();
    for (const id of todo) await chats.getState().markRead(id);
    ui.getState().showToast({ text: todo.length ? `Marked ${countOf(todo.length, 'chat')} as read` : 'Nothing new to mark' });
  };
  const save = async (ids: string[]) => {
    sel.clear();
    const res = await each(ids, async (id) => {
      const r = await chats.getState().saveChat(id);
      return r.ok ? { ok: true as const } : r;
    });
    toast(res.skipped.length ? resultText('Saved', res, 'chat') : `Saved ${countOf(res.done.length, 'chat')} to the wiki as analyses`, res);
  };

  const ids = () => sel.ordered;
  const actions: SelectionAction[] = [
    { id: 'pin', label: 'Pin', icon: 'pin', onSelect: () => void setPinned(ids(), true) },
    {
      id: 'export', label: 'Export .md', icon: 'export', shortcut: '⌘⇧E', disabled: !exportMd,
      onSelect: () => exportMd?.(pick(ids())),
    },
    { id: 'delete', label: 'Delete', icon: 'trash', shortcut: '⌘⌫', danger: true, onSelect: () => setDeleteIds(ids()) },
  ];
  const more: SelectionAction[] = [
    { id: 'unpin', label: 'Unpin', icon: 'unpin', onSelect: () => void setPinned(ids(), false) },
    { id: 'read', label: 'Mark as read', icon: 'check', onSelect: () => void markRead(ids()) },
    { id: 'save', label: 'Save to wiki as analyses', icon: 'saveWiki', onSelect: () => void save(ids()) },
  ];

  const doomed = pick(deleteIds ?? []);
  const answering = doomed.filter((c) => c.state === 'answering');
  const overlays = (
    <>
      <SelectionBar count={sel.selected.size} variant={variant} actions={actions} more={more} onClear={sel.clear} />
      {exp.dialog}
      <ShortcutsPopover open={sel.shortcutsOpen} onClose={() => sel.setShortcutsOpen(false)} anchorRef={sel.listRef}
        has={{ delete: true, export: Boolean(exportMd) }} />
      <BatchDeleteDialog open={deleteIds !== null} onClose={() => setDeleteIds(null)} count={doomed.length} testId="delete-chats"
        title={`Delete ${countOf(doomed.length, 'chat')}?`}
        preview={async () => (
          <ul className="kb-delprev__list">
            <li>{namesList(doomed.map((c) => c.title))} and {doomed.length === 1 ? 'its messages' : 'their messages'}</li>
            <li>Wiki pages saved from them stay</li>
            <li>{answering.length
              ? <>{namesList(answering.map((c) => c.title))} {answering.length === 1 ? 'is' : 'are'} still answering — skipped</>
              : 'A chat that is still answering is skipped — it says so'}</li>
          </ul>
        )}
        onDelete={async () => {
          const res: BatchResult = { done: [], skipped: [] };
          for (const c of doomed) {
            if (c.state === 'answering') { res.skipped.push({ id: c.id, reason: `“${c.title}” is still answering` }); continue; }
            const r = await chats.getState().remove(c.id);
            if (r.ok) res.done.push(c.id); else res.skipped.push({ id: c.id, reason: r.error });
          }
          setDeleteIds(null);
          sel.clear();
          toast(resultText('Deleted', res, 'chat'), res);
        }} />
    </>
  );
  return { sel, overlays };
}
