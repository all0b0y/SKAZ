import { useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import type { KbDeletePreview, KbFolder, KbMaterialSummary } from '../../api/kb/types.gen';
import { Icon, Popover } from '../ui';
import { PageChip } from '../document/parts';
import { plural } from '../document/text';
import { NameField } from '../library/NameField';
import { useLibrary, useServices } from '../state/context';
import {
  BatchDeleteDialog, ContextMenu, SelectionBar, ShortcutsPopover, countOf, endItemsDrag, namesList, resultText, runOneByOne,
  startItemsDrag, useListSelection, type ListSelection, type SelectionAction,
} from '../ui/selection/index';
import type { MenuItem } from '../ui/Popover';

/**
 * Batch actions on materials (0.3.1 F2/F3/F4), shared by the All materials table and the side
 * panel: over the existing routes one by one (contract «Пакетные действия»).
 */

/** Rows that can't be selected or dragged, with the reason shown on them (contract F4). */
export function materialReason(m: Pick<KbMaterialSummary, 'status' | 'wiki_state'>): string | null {
  if (m.status === 'recording') return 'Being recorded — can’t be selected yet';
  if (m.wiki_state === 'processing') return 'Being added to the wiki — wait until it’s done';
  return null;
}

/** Why a dragged material can't go into a folder, or null. */
export function dragBlockReason(m: Pick<KbMaterialSummary, 'status' | 'wiki_state'>): string | null {
  if (m.status === 'recording') return 'Being recorded — can’t be moved yet';
  if (m.wiki_state === 'processing') return 'Being added to the wiki — can’t be moved yet';
  return null;
}

/** Ready and not in the wiki yet (or the last try failed): "Add to wiki · N" counts these. */
export const canAddToWiki = (m: KbMaterialSummary) => m.status === 'ready' && (m.wiki_state === 'not_in_wiki' || m.wiki_state === 'failed');

export interface MovedMaterial { id: string; from: string }

export function useMaterialBatch() {
  const { client, library, ui, composer } = useServices();
  const nameOf = (folderId: string) => library.getState().folders.find((f) => f.id === folderId)?.name ?? 'the folder';

  const undo = async (moved: MovedMaterial[]) => {
    const from = new Map(moved.map((m) => [m.id, m.from]));
    const res = await runOneByOne(moved.map((m) => m.id), (id) => client.call('PATCH /kb/materials/{material_id}', {
      path: { material_id: id }, body: { folder_id: from.get(id)! },
    }));
    await library.getState().loadContent();
    ui.getState().showToast(res.skipped.length
      ? { text: resultText('Moved back', res, 'material'), tone: 'problem' }
      : { text: `Moved ${countOf(res.done.length, 'material')} back` });
  };

  /** Move to a folder, one PATCH each; the toast says what moved and offers Undo (back to the old folders). */
  const move = async (list: ReadonlyArray<Pick<KbMaterialSummary, 'id' | 'folder_id'>>, folderId: string) => {
    const name = nameOf(folderId);
    const todo = list.filter((m) => m.folder_id !== folderId);
    if (!todo.length) {
      ui.getState().showToast({ text: `Already in «${name}»` });
      return { done: [], skipped: [] };
    }
    const from = new Map(todo.map((m) => [m.id, m.folder_id]));
    const res = await runOneByOne(todo.map((m) => m.id), (id) => client.call('PATCH /kb/materials/{material_id}', {
      path: { material_id: id }, body: { folder_id: folderId },
    }));
    await library.getState().loadContent();
    const moved = res.done.map((id) => ({ id, from: from.get(id)! }));
    ui.getState().showToast({
      text: res.skipped.length ? resultText('Moved', res, 'material') : `Moved ${countOf(moved.length, 'material')} to «${name}»`,
      tone: res.skipped.length ? 'problem' : 'done',
      action: moved.length ? { label: 'Undo', run: () => void undo(moved) } : undefined,
    });
    return res;
  };

  /** "Ask in chat" / ⌘↩: the materials become @-mentions in the current chat's field. */
  const ask = (list: ReadonlyArray<Pick<KbMaterialSummary, 'id' | 'title'>>) => {
    if (!list.length) return;
    const s = ui.getState();
    if (s.center !== 'chat') s.showCenter('chat');
    if (s.docExpanded) s.toggleDocExpanded();
    composer.getState().push(list.map((m) => ({ kind: 'mention' as const, ref: { type: 'material' as const, id: m.id, title: m.title } })), { focus: true });
  };

  const addToWiki = async (list: ReadonlyArray<KbMaterialSummary>) => {
    const todo = list.filter(canAddToWiki);
    if (!todo.length) return;
    const res = await runOneByOne(todo.map((m) => m.id), (id) => client.call('POST /kb/materials/{material_id}/ingest', { path: { material_id: id } }));
    await library.getState().loadContent();
    ui.getState().showToast(res.skipped.length
      ? { text: resultText('Started adding', res, 'material'), tone: 'problem' }
      : { text: `Adding ${countOf(res.done.length, 'material')} to the wiki` });
  };

  return { move, ask, addToWiki, undo };
}

/** Preview of deleting several materials: the per-material previews, summed. */
export async function materialsDeletePreview(client: ReturnType<typeof useServices>['client'], list: ReadonlyArray<KbMaterialSummary>) {
  const previews: KbDeletePreview[] = [];
  for (const m of list) previews.push(await client.call('GET /kb/materials/{material_id}/delete-preview', { path: { material_id: m.id } }));
  const claims = previews.reduce((n, p) => n + p.claims_removed, 0);
  const uniq = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
  const removed = uniq(previews.flatMap((p) => p.pages_removed));
  const changed = uniq(previews.flatMap((p) => p.pages_changed)).filter((p) => !removed.some((r) => r.id === p.id));
  return (
    <div className="kb-delprev">
      <ul className="kb-delprev__list">
        <li>{namesList(list.map((m) => m.title))} and {list.length === 1 ? 'its file' : 'their files'}</li>
        <li>{claims === 0 && !removed.length && !changed.length ? 'None of them is a source in the wiki — no page loses a source.'
          : claims === 0 ? 'No statements in the wiki come from these materials alone.'
            : <><b>{plural(claims, 'statement')}</b> from these materials {claims === 1 ? 'leaves' : 'leave'} the wiki.</>}</li>
        <li>Your notes are never touched.</li>
      </ul>
      {removed.length > 0 && (
        <div className="kb-delprev__group">
          <p className="kb-delprev__head">Pages removed</p>
          <div className="kb-chips">{removed.map((p) => <PageChip key={p.id} page={p} />)}</div>
        </div>
      )}
      {changed.length > 0 && (
        <div className="kb-delprev__group">
          <p className="kb-delprev__head">Pages changed</p>
          <div className="kb-chips">{changed.map((p) => <PageChip key={p.id} page={p} />)}</div>
        </div>
      )}
    </div>
  );
}

/** "Delete N materials?" — one window built from the delete previews, then DELETE one by one. */
export function DeleteMaterialsDialog({ list, open, onClose, onDone }: {
  list: ReadonlyArray<KbMaterialSummary>; open: boolean; onClose: () => void; onDone: () => void;
}) {
  const { client, library, ui } = useServices();
  return (
    <BatchDeleteDialog open={open} onClose={onClose} count={list.length} testId="delete-materials"
      title={`Delete ${countOf(list.length, 'material')}?`}
      preview={() => materialsDeletePreview(client, list)}
      onDelete={async () => {
        const res = await runOneByOne(list.map((m) => m.id), (id) => client.call('DELETE /kb/materials/{material_id}', { path: { material_id: id } }));
        onClose();
        for (const id of res.done) void library.getState().forgetMaterial(id);
        ui.getState().showToast({ text: resultText('Deleted', res, 'material'), tone: res.skipped.length ? 'problem' : 'done' });
        onDone();
      }} />
  );
}

/**
 * "Move to…" (mockup lib-v1): "Move N materials to", the folders with their counts, "New folder…".
 * A typed new folder is made and the materials go into it in one step (as F1).
 */
export function MoveToMenu({ open, onClose, anchorRef, count, onPick }: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  count: number;
  onPick: (folderId: string) => void;
}) {
  const folders = useLibrary((s) => s.folders);
  const { library } = useServices();
  const [creating, setCreating] = useState(false);
  const close = () => { setCreating(false); onClose(); };
  return (
    <Popover open={open} onClose={close} anchorRef={anchorRef} label="Move to" placement="top-start" width={260} className="kb-moveto">
      <p className="kb-moveto__head">Move {countOf(count, 'material')} to</p>
      <div role="menu" aria-label="Folders" className="kb-menu__list">
        {folders.map((f: KbFolder) => (
          <button key={f.id} type="button" role="menuitem" className="kb-menu__item" onClick={() => { close(); onPick(f.id); }}>
            <Icon name={f.system ? 'inbox' : 'folder'} size={14} />
            <span className="kb-menu__label">{f.name}</span>
            <span className="kb-menu__note">{f.material_count}</span>
          </button>
        ))}
        {!creating && (
          <button type="button" role="menuitem" className="kb-menu__item" onClick={() => setCreating(true)}>
            <Icon name="folderPlus" size={14} />
            <span className="kb-menu__label">New folder…</span>
          </button>
        )}
      </div>
      {creating && (
        <NameField label="New folder name" placeholder="Folder name"
          onSubmit={async (name) => {
            const r = await library.getState().createFolder(name);
            if (r.ok) { onPick(r.value.id); }
            return r;
          }}
          onDone={close} />
      )}
    </Popover>
  );
}

/** A ref whose element is chosen when a popup opens (the bar button, else the list). */
export function useAnchor(): [RefObject<HTMLElement | null>, (el: HTMLElement | null) => void] {
  const ref = useRef<HTMLElement | null>(null);
  return [ref, (el) => { ref.current = el; }];
}

/** The actions of a material selection, for the bar, ⋯ and the right-click menu. */
export function materialActions(list: ReadonlyArray<KbMaterialSummary>, run: {
  move: () => void; ask: () => void; addToWiki: () => void; exportMd: (() => void) | null; remove: () => void;
}): Record<'full' | 'compact', { bar: SelectionAction[]; more: SelectionAction[] }> & { menu: MenuItem[] } {
  const toWiki = list.filter(canAddToWiki).length;
  const move: SelectionAction = { id: 'move', label: 'Move to…', icon: 'folder', shortcut: '⌘⇧M', onSelect: run.move };
  const ask: SelectionAction = { id: 'ask', label: 'Ask in chat', icon: 'mention', shortcut: '⌘↩', onSelect: run.ask };
  const wiki: SelectionAction = { id: 'wiki', label: `Add to wiki · ${toWiki}`, icon: 'saveWiki', onSelect: run.addToWiki, disabled: toWiki === 0 };
  const exp: SelectionAction = {
    id: 'export', label: 'Export .md', icon: 'export', shortcut: '⌘⇧E', onSelect: run.exportMd ?? (() => undefined),
    disabled: !run.exportMd, note: run.exportMd ? undefined : 'In the desktop app',
  };
  const del: SelectionAction = { id: 'delete', label: 'Delete', icon: 'trash', shortcut: '⌘⌫', danger: true, onSelect: run.remove };
  const menu: MenuItem[] = [
    { id: 'move', label: 'Move to…', icon: 'folder', note: '⌘⇧M', onSelect: run.move },
    { id: 'ask', label: 'Ask in chat', icon: 'mention', note: '⌘↩', onSelect: run.ask },
    ...(toWiki ? [{ id: 'wiki', label: `Add to wiki · ${toWiki}`, icon: 'saveWiki' as const, onSelect: run.addToWiki }] : []),
    { id: 'export', label: 'Export .md', icon: 'export', note: run.exportMd ? '⌘⇧E' : 'In the desktop app', disabled: !run.exportMd, onSelect: run.exportMd ?? (() => undefined) },
    { id: 'delete', label: `Delete ${countOf(list.length, 'material')}`, icon: 'trash', danger: true, note: '⌘⌫', onSelect: run.remove },
  ];
  return {
    // Table (full bar, mockup lib-v1 A): Move to… · Ask in chat · Add to wiki · N · ⋯ Export · Delete.
    full: { bar: [move, ask, ...(toWiki ? [wiki] : []), del], more: [exp] },
    // Side panel (compact, lib-v2): Move to… · Ask in chat · ⋯ Add to wiki · N, Export · Delete.
    compact: { bar: [move, ask, del], more: [wiki, exp] },
    menu,
  };
}

/**
 * Everything a materials list needs to select several (0.3.1 F2/F3/F4): the hook, the bar,
 * Move to…, the delete window, the right-click menu, ⌘/ and dragging rows out.
 */
export function useMaterialSelection({ rows, resetKey, variant, onOpen, exportMd }: {
  rows: ReadonlyArray<KbMaterialSummary>;
  resetKey?: unknown;
  variant: 'full' | 'compact';
  onOpen: (id: string) => void;
  /** Export .md of these materials, or null where the host can't save files. */
  exportMd: ((list: KbMaterialSummary[]) => void) | null;
}): { sel: ListSelection; overlays: ReactNode; dragProps: (m: KbMaterialSummary) => DragRowProps } {
  const batch = useMaterialBatch();
  const byId = new Map(rows.map((m) => [m.id, m]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((m): m is KbMaterialSummary => Boolean(m));
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<{ ids: string[]; at: { x: number; y: number } } | null>(null);
  const [anchor, setAnchor] = useAnchor();
  const sel = useListSelection({
    ids: rows.map((m) => m.id),
    reasonNotSelectable: (id) => { const m = byId.get(id); return m ? materialReason(m) : null; },
    resetKey,
    onOpen,
    onAttach: (ids) => { batch.ask(pick(ids)); },
    onMove: (ids) => openMove(ids),
    onDelete: (ids) => setDeleteIds(ids),
    onExport: exportMd ? (ids) => exportMd(pick(ids)) : undefined,
    onContextMenu: (ids, at) => { if (ids.length) setMenu({ ids, at }); },
  });
  function openMove(ids: string[]) {
    // Next to the bar's "Move to…", else the list itself.
    const fromBar = sel.listRef.current?.querySelector<HTMLElement>('[data-sel-bar] [data-action="move"]');
    setAnchor(fromBar ?? sel.listRef.current);
    setMoveIds(ids);
  }
  const selectedList = pick(sel.ordered);
  const run = (ids: () => string[]) => ({
    move: () => openMove(ids()),
    ask: () => { batch.ask(pick(ids())); sel.clear(); },
    addToWiki: () => { void batch.addToWiki(pick(ids())).then(sel.clear); },
    exportMd: exportMd ? () => { exportMd(pick(ids())); } : null,
    remove: () => setDeleteIds(ids()),
  });
  const barActions = materialActions(selectedList, run(() => sel.ordered))[variant];
  const menuItems = menu ? materialActions(pick(menu.ids), run(() => menu.ids)).menu : [];

  const dragProps = (m: KbMaterialSummary): DragRowProps => ({
    draggable: true,
    onDragStart: (e) => {
      // The selection when the row is in it, else this row alone (mockup lib-v1 «Drag»).
      const ids = sel.selected.has(m.id) ? sel.ordered : [m.id];
      const list = pick(ids);
      const blocked = list.map(dragBlockReason).find(Boolean) ?? null;
      startItemsDrag(e.dataTransfer, { items: list.map((x) => ({ type: 'material', id: x.id })), title: m.title, blocked }, e.currentTarget);
    },
    onDragEnd: () => endItemsDrag(),
  });

  const overlays = (
    <>
      <SelectionBar count={sel.selected.size} variant={variant} actions={barActions.bar} more={barActions.more} onClear={sel.clear} />
      <MoveToMenu open={moveIds !== null} onClose={() => setMoveIds(null)} anchorRef={anchor} count={moveIds?.length ?? 0}
        onPick={(folderId) => { const list = pick(moveIds ?? []); setMoveIds(null); void batch.move(list, folderId).then(() => sel.clear()); }} />
      <DeleteMaterialsDialog list={pick(deleteIds ?? [])} open={deleteIds !== null} onClose={() => setDeleteIds(null)} onDone={sel.clear} />
      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)} label="Material actions" items={menuItems} />
      <ShortcutsPopover open={sel.shortcutsOpen} onClose={() => sel.setShortcutsOpen(false)} anchorRef={sel.listRef}
        has={{ move: true, attach: true, delete: true, export: Boolean(exportMd) }} />
    </>
  );
  return { sel, overlays, dragProps };
}

export interface DragRowProps {
  draggable: boolean;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}
