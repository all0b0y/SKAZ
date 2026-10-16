import { useState, type ReactNode } from 'react';
import type { KbPageDeletePreview, KbPageSummary } from '../../api/kb/types.gen';
import { plural } from '../document/text';
import { useOpenInObsidian } from '../document/fileActions';
import { useServices } from '../state/context';
import { useExportItems } from '../document/exportItems';
import {
  BatchDeleteDialog, SelectionBar, ShortcutsPopover, countOf, endItemsDrag, namesList, resultText, runOneByOne,
  startItemsDrag, useListSelection, type ListSelection, type SelectionAction,
} from '../ui/selection/index';
import type { DragRowProps } from '../materials/materialBatch';

/** Pages as @-mentions in the current chat's field (as "Ask about page"). */
export function useAskAboutPages() {
  const { ui, composer } = useServices();
  return (list: ReadonlyArray<Pick<KbPageSummary, 'id' | 'title'>>) => {
    if (!list.length) return;
    const s = ui.getState();
    if (s.center !== 'chat') s.showCenter('chat');
    if (s.docExpanded) s.toggleDocExpanded();
    composer.getState().push(list.map((p) => ({ kind: 'mention' as const, ref: { type: 'page' as const, id: p.id, title: p.title } })), { focus: true });
  };
}

/**
 * Wiki pages in the side panel, several at once (0.3.1 F4, mockup lib-v2 «Wiki pages»): Ask in
 * chat, Export .md, Delete; ⋯ Open in Obsidian. Deleting is the user's own act: one consequences
 * window from the page delete previews, no agent permission card.
 */
export function usePageSelection({ pages, resetKey, onOpen }: {
  pages: ReadonlyArray<KbPageSummary>;
  resetKey?: unknown;
  onOpen: (id: string) => void;
}): { sel: ListSelection; overlays: ReactNode; dragProps: (p: KbPageSummary) => DragRowProps } {
  const { client, chats, ui, library } = useServices();
  const exp = useExportItems();
  const exportMd = exp.run ? (picked: KbPageSummary[]) => { exp.run!(picked.map((p) => ({ type: 'page' as const, id: p.id }))); } : null;
  const ask = useAskAboutPages();
  const obsidian = useOpenInObsidian();
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const pick = (ids: readonly string[]) => ids.map((id) => byId.get(id)).filter((p): p is KbPageSummary => Boolean(p));
  const sel = useListSelection({
    ids: pages.map((p) => p.id),
    resetKey,
    onOpen,
    onAttach: (ids) => { ask(pick(ids)); sel.clear(); },
    onDelete: (ids) => setDeleteIds(ids),
    onExport: exportMd ? (ids) => exportMd(pick(ids)) : undefined,
  });
  const ids = () => sel.ordered;
  const actions: SelectionAction[] = [
    { id: 'ask', label: 'Ask in chat', icon: 'mention', shortcut: '⌘↩', onSelect: () => { ask(pick(ids())); sel.clear(); } },
    { id: 'export', label: 'Export .md', icon: 'export', shortcut: '⌘⇧E', disabled: !exportMd, onSelect: () => exportMd?.(pick(ids())) },
    { id: 'delete', label: 'Delete', icon: 'trash', shortcut: '⌘⌫', danger: true, onSelect: () => setDeleteIds(ids()) },
  ];
  const one = sel.ordered.length === 1;
  const more: SelectionAction[] = [{
    id: 'obsidian', label: 'Open in Obsidian', icon: 'external', disabled: !obsidian.open || !one,
    note: !obsidian.open ? 'In the desktop app' : one ? undefined : 'One page at a time',
    onSelect: () => { const id = sel.ordered[0]; if (id && obsidian.open) void obsidian.open({ kind: 'page', id }); },
  }];

  const doomed = pick(deleteIds ?? []);
  const preview = async () => {
    const previews: KbPageDeletePreview[] = [];
    for (const p of doomed) previews.push(await client.call('GET /kb/wiki/pages/{page_id}/delete-preview', { path: { page_id: p.id } }));
    const links = previews.reduce((n, p) => n + p.links_unlinked, 0);
    const notes = previews.reduce((n, p) => n + p.user_notes, 0);
    return (
      <ul className="kb-delprev__list">
        <li>{namesList(doomed.map((p) => p.title))}</li>
        <li>{links === 0 ? 'No other page links here.'
          : <><b>{plural(links, 'link')}</b> in other pages {links === 1 ? 'is' : 'are'} removed; the words stay.</>}</li>
        {notes > 0 && <li><b>{notes === 1 ? 'Your note on these pages' : `Your ${notes} notes on these pages`}</b> {notes === 1 ? 'is' : 'are'} deleted with them.</li>}
        <li>Materials stay in the library.</li>
        <li>Index and Log can’t be selected — SKAZ keeps them.</li>
      </ul>
    );
  };

  const dragProps = (p: KbPageSummary): DragRowProps => ({
    draggable: true,
    onDragStart: (e) => {
      const list = sel.selected.has(p.id) ? pick(sel.ordered) : [p];
      startItemsDrag(e.dataTransfer, { items: list.map((x) => ({ type: 'page', id: x.id, title: x.title })), title: p.title, blocked: null }, e.currentTarget);
    },
    // Dropped somewhere that took it (a folder, the message field): the action is done, the selection goes.
    onDragEnd: (e) => { endItemsDrag(); if (e.dataTransfer && e.dataTransfer.dropEffect !== 'none') sel.clear(); },
  });

  const overlays = (
    <>
      <SelectionBar count={sel.selected.size} variant="compact" actions={actions} more={more} onClear={sel.clear} />
      {obsidian.message && <div className="kb-side__pad">{obsidian.message}</div>}
      {exp.dialog}
      <ShortcutsPopover open={sel.shortcutsOpen} onClose={() => sel.setShortcutsOpen(false)} anchorRef={sel.listRef}
        has={{ attach: true, delete: true, export: Boolean(exportMd) }} />
      <BatchDeleteDialog open={deleteIds !== null} onClose={() => setDeleteIds(null)} count={doomed.length} testId="delete-pages"
        title={`Delete ${countOf(doomed.length, 'page')}?`} preview={preview}
        onDelete={async () => {
          const res = await runOneByOne(doomed.map((p) => p.id), (id) => client.call('DELETE /kb/wiki/pages/{page_id}', { path: { page_id: id } }));
          setDeleteIds(null);
          sel.clear();
          for (const id of res.done) chats.getState().forget({ page: id });
          const right = ui.getState().right;
          if (right?.kind === 'doc' && right.target.type === 'page' && res.done.includes(right.target.id)) ui.getState().closeDoc();
          void library.getState().loadContent();
          ui.getState().showToast({ text: resultText('Deleted', res, 'page'), tone: res.skipped.length ? 'problem' : 'done' });
        }} />
    </>
  );
  return { sel, overlays, dragProps };
}
