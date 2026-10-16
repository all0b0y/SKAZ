import { useRef, useState, type DragEvent } from 'react';
import type { KbFolder, KbMaterialSummary } from '../../api/kb/types.gen';
import { Banner, Button, EmptyState, Icon, IconButton, Menu, Spinner } from '../ui';
import { useLibrary, useServices, useUi } from '../state/context';
import { KIND_ICON, folderTone } from './materialMeta';
import { NameField } from './NameField';
import { SelectionCheckbox, hasDragFiles, hasDragItems, readDragItems, useItemsDrag, type ListSelection } from '../ui/selection/index';
import { useMaterialBatch, useMaterialSelection, type DragRowProps } from '../materials/materialBatch';

const RECENT = 5;

/** Side panel "Materials": recent + folders + "All materials · N", on real /kb data. */
export function LibraryPanel() {
  const library = useLibrary((s) => s.library);
  const libraryLoad = useLibrary((s) => s.libraryLoad);
  const libraryError = useLibrary((s) => s.libraryError);
  const openFolderId = useLibrary((s) => s.openFolderId);
  const { library: store } = useServices();
  const setLibrarySetupOpen = useUi((s) => s.setLibrarySetupOpen);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (libraryLoad === 'idle' || (libraryLoad === 'loading' && !library)) {
    return <div className="kb-side__wait"><Spinner label="Reading the library" /></div>;
  }
  if (libraryLoad === 'error' || !library) {
    return (
      <div className="kb-side__pad">
        <Banner tone="error" title="Couldn’t read the library."
          actions={<Button size="sm" variant="fill" icon="retry" onClick={() => void store.getState().loadLibrary()}>Try again</Button>}>
          {libraryError}
        </Banner>
      </div>
    );
  }
  if (library.state === 'not_configured') {
    return (
      <EmptyState
        icon="materials"
        title="Library isn’t connected"
        action={<Button variant="fill" size="sm" onClick={() => setLibrarySetupOpen(true)}>Choose where to keep it</Button>}
      >
        Materials and wiki pages are plain .md files in a folder you choose.
      </EmptyState>
    );
  }
  if (library.state === 'unavailable') {
    const retry = async () => {
      setRetrying(true);
      const result = await store.getState().retry();
      setRetrying(false);
      setRetryError(result.ok ? (result.value.state === 'ready' ? null : result.value.reason) : result.error);
    };
    return (
      <div className="kb-side__pad">
        <Banner
          tone="error"
          title="Library folder is unavailable."
          actions={(
            <>
              <Button size="sm" variant="fill" icon="retry" busy={retrying} onClick={() => void retry()}>Try again</Button>
              <Button size="sm" onClick={() => setLibrarySetupOpen(true)}>Choose another place</Button>
            </>
          )}
        >
          {retryError ?? library.reason} Nothing was deleted.
        </Banner>
      </div>
    );
  }
  const body = openFolderId ? <FolderView folderId={openFolderId} /> : <Overview />;
  if (!library.indexing) return body;
  return (
    <>
      <p className="kb-side__note kb-muted" data-testid="library-indexing">
        <Spinner label="Indexing the library" size="sm" />
        <span>Indexing the library… The newest changes may appear in a moment.</span>
      </p>
      {body}
    </>
  );
}

function MaterialRow({ material, tone, meta, sel, drag }: {
  material: KbMaterialSummary; tone?: string; meta?: string; sel: ListSelection; drag: DragRowProps;
}) {
  const openDoc = useUi((s) => s.openDoc);
  const current = useUi((s) => s.docMaterialId === material.id);
  const reason = sel.reasonOf(material.id);
  return (
    <li {...sel.rowProps(material.id)} {...drag}>
      <div role="gridcell">
        <button
          type="button"
          className={`kb-row${current ? ' is-current' : ''}${reason ? ' kb-row--dim' : ''}`}
          aria-current={current ? 'true' : undefined}
          onClick={() => openDoc(material.id)}
        >
          <SelectionCheckbox checked={sel.selected.has(material.id)} reason={reason} />
          <Icon name={KIND_ICON[material.kind]} size={16} className="kb-row__icon" />
          <span className="kb-row__text">{material.title}</span>
          {tone && <span className="kb-fdot" style={{ background: tone }} aria-hidden="true" />}
          {meta && <span className="kb-row__meta">{meta}</span>}
        </button>
      </div>
    </li>
  );
}

/** The side panel's materials list: select several (compact bar), drag rows out (0.3.1 F3/F4). */
function MaterialList({ items, label, labelledBy, resetKey, toneOf, metaOf }: {
  items: KbMaterialSummary[];
  label?: string;
  labelledBy?: string;
  resetKey: unknown;
  toneOf: (m: KbMaterialSummary) => string | undefined;
  metaOf?: (m: KbMaterialSummary) => string | undefined;
}) {
  const openDoc = useUi((s) => s.openDoc);
  const { sel, overlays, dragProps } = useMaterialSelection({ rows: items, resetKey, variant: 'compact', onOpen: openDoc });
  return (
    <div className="kb-sellist" {...sel.listProps}>
      <ul className="kb-list" {...sel.gridProps} aria-label={label} aria-labelledby={labelledBy}>
        {items.map((m) => <MaterialRow key={m.id} material={m} tone={toneOf(m)} meta={metaOf?.(m)} sel={sel} drag={dragProps(m)} />)}
      </ul>
      {overlays}
    </div>
  );
}

function Overview() {
  const folders = useLibrary((s) => s.folders);
  const materials = useLibrary((s) => s.materials);
  const contentLoad = useLibrary((s) => s.contentLoad);
  const contentError = useLibrary((s) => s.contentError);
  const { library: store } = useServices();
  const [creating, setCreating] = useState(false);
  const setAddOpen = useUi((s) => s.setAddMaterialOpen);
  const showCenter = useUi((s) => s.showCenter);
  const allOpen = useUi((s) => s.center === 'materials');

  const userFolders = folders.filter((f) => !f.system);
  const toneOf = (folderId: string) => {
    const i = userFolders.findIndex((f) => f.id === folderId);
    return i >= 0 ? folderTone(i) : undefined;
  };
  const systemName = (folderId: string) => folders.find((f) => f.id === folderId && f.system)?.name;

  return (
    <div className="kb-side__scroll">
      <button type="button" className="kb-row kb-row--action" aria-haspopup="dialog" onClick={() => setAddOpen(true)}>
        <Icon name="plus" size={16} className="kb-row__icon" />
        <span className="kb-row__text">Add material</span>
      </button>

      {contentLoad === 'error' && (
        <div className="kb-side__pad">
          <Banner tone="error" title="Couldn’t load materials."
            actions={<Button size="sm" icon="retry" onClick={() => void store.getState().loadContent()}>Try again</Button>}>
            {contentError}
          </Banner>
        </div>
      )}

      <h3 className="kb-subhead" id="kb-recent">Recent</h3>
      {materials.length === 0 ? (
        <p className="kb-side__note">{contentLoad === 'loading' ? 'Loading…' : 'No materials yet.'}</p>
      ) : (
        <MaterialList items={materials.slice(0, RECENT)} labelledBy="kb-recent" resetKey="recent"
          toneOf={(m) => toneOf(m.folder_id)} metaOf={(m) => systemName(m.folder_id)} />
      )}

      <div className="kb-subhead kb-subhead--row">
        <h3 className="kb-subhead__text" id="kb-folders">Folders</h3>
        <IconButton icon="folderPlus" label="New folder" size="sm" onClick={() => setCreating(true)} disabled={creating} />
      </div>
      <DropNote />
      <ul className="kb-list" aria-labelledby="kb-folders">
        {folders.map((folder) => (
          <FolderRow key={folder.id} folder={folder} tone={toneOf(folder.id)} materialsHere={materials.some((m) => m.folder_id === folder.id) || folder.material_count > 0} />
        ))}
      </ul>
      {creating && (
        <NameField
          label="New folder name"
          placeholder="Folder name"
          onSubmit={(name) => store.getState().createFolder(name)}
          onDone={() => setCreating(false)}
        />
      )}
      <button type="button" className={`kb-row kb-row--all${allOpen ? ' is-current' : ''}`} data-testid="all-materials"
        aria-current={allOpen ? 'true' : undefined} onClick={() => showCenter(allOpen ? 'chat' : 'materials')}>
        <span className="kb-row__text">All materials · {materials.length}</span>
      </button>
    </div>
  );
}

function FolderRow({ folder, tone, materialsHere }: { folder: KbFolder; tone?: string; materialsHere: boolean }) {
  const { library: store } = useServices();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const drop = useFolderDrop(folder);

  if (renaming) {
    return (
      <li>
        <NameField
          label={`Rename folder ${folder.name}`}
          initial={folder.name}
          onSubmit={(name) => store.getState().renameFolder(folder.id, name)}
          onDone={() => { setRenaming(false); requestAnimationFrame(() => moreRef.current?.focus()); }}
        />
      </li>
    );
  }

  const remove = async () => {
    const result = await store.getState().deleteFolder(folder.id);
    if (!result.ok) setError(result.error);
  };

  return (
    <li className="kb-folder">
      <div className="kb-folder__line">
        <button type="button" className={`kb-row kb-row--folder${drop.className}`} onClick={() => void store.getState().openFolder(folder.id)}
          title={drop.reason ?? undefined} {...drop.handlers}>
          <Icon name={folder.system ? 'inbox' : 'folder'} size={16} className="kb-row__icon" />
          <span className="kb-row__text">{folder.name}</span>
          {tone && <span className="kb-fdot" style={{ background: tone }} aria-hidden="true" />}
          <span className="kb-row__count" aria-label={`${folder.material_count} ${folder.material_count === 1 ? 'material' : 'materials'}`}>{folder.material_count}</span>
        </button>
        {!folder.system && (
          <>
            <IconButton
              ref={moreRef}
              icon="more"
              size="sm"
              label={`Folder actions: ${folder.name}`}
              className="kb-folder__more"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setError(null); setMenuOpen((v) => !v); }}
              tooltip={false}
            />
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchorRef={moreRef}
              label={`Folder ${folder.name}`}
              items={[
                { id: 'rename', label: 'Rename', icon: 'pencil', onSelect: () => setRenaming(true) },
                {
                  id: 'delete', label: 'Delete', icon: 'trash', danger: true,
                  disabled: materialsHere, note: materialsHere ? 'Not empty' : undefined,
                  onSelect: () => void remove(),
                },
              ]}
            />
          </>
        )}
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </li>
  );
}

function FolderView({ folderId }: { folderId: string }) {
  const folders = useLibrary((s) => s.folders);
  const items = useLibrary((s) => s.folderMaterials);
  const load = useLibrary((s) => s.folderLoad);
  const error = useLibrary((s) => s.folderError);
  const { library: store } = useServices();
  const folder = folders.find((f) => f.id === folderId);
  const userFolders = folders.filter((f) => !f.system);
  const i = userFolders.findIndex((f) => f.id === folderId);
  const tone = i >= 0 ? folderTone(i) : undefined;
  return (
    <div className="kb-side__scroll">
      <button type="button" className="kb-row kb-row--back" onClick={() => void store.getState().openFolder(null)}>
        <Icon name="chevronLeft" size={16} className="kb-row__icon" />
        <span className="kb-row__text">All folders</span>
      </button>
      <h3 className="kb-subhead kb-subhead--folder" id="kb-folder-title">
        <Icon name={folder?.system ? 'inbox' : 'folder'} size={14} />
        <span className="kb-subhead__text">{folder?.name ?? 'Folder'}</span>
      </h3>
      {load === 'loading' && <div className="kb-side__wait"><Spinner label="Loading the folder" size="sm" /></div>}
      {load === 'error' && (
        <div className="kb-side__pad">
          <Banner tone="error" title="Couldn’t load this folder."
            actions={<Button size="sm" icon="retry" onClick={() => void store.getState().openFolder(folderId)}>Try again</Button>}>
            {error}
          </Banner>
        </div>
      )}
      {load === 'ready' && items.length === 0 && (
        <EmptyState icon="folder" title="No materials in this folder" compact />
      )}
      {items.length > 0 && (
        <MaterialList items={items} labelledBy="kb-folder-title" resetKey={folderId} toneOf={() => tone} />
      )}
    </div>
  );
}

/** Why the dragged items can't go into a folder (shown on the dimmed folders), or null. */
function dropBlock(drag: ReturnType<typeof useItemsDrag>): string | null {
  if (!drag) return null;
  if (drag.items.some((i) => i.type !== 'material')) return 'Only materials go into folders';
  return drag.blocked;
}

/** Under "Folders" while a drag that can't land here is in progress: the reason, in words. */
function DropNote() {
  const why = dropBlock(useItemsDrag());
  if (!why) return null;
  return <p className="kb-dropnote" role="status">{why}</p>;
}

/**
 * A folder row as a drop target (0.3.1 F3): materials dragged from a list move here (outline, toast
 * with Undo; the same folder → "Already in «X»"); files from Finder open "Add material" with them
 * and this folder. Drags that can't land here dim the row and say why.
 */
function useFolderDrop(folder: KbFolder) {
  const { library, ui, bridge } = useServices();
  const batch = useMaterialBatch();
  const drag = useItemsDrag();
  const [over, setOver] = useState(false);
  const blocked = dropBlock(drag);
  const accepts = (e: DragEvent<HTMLElement>) => (hasDragItems(e.dataTransfer) ? !dropBlock(drag) : hasDragFiles(e.dataTransfer));
  const handlers = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = hasDragItems(e.dataTransfer) ? 'move' : 'copy';
      if (!over) setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent<HTMLElement>) => {
      setOver(false);
      if (hasDragItems(e.dataTransfer)) {
        e.preventDefault();
        if (dropBlock(drag)) return;
        const items = readDragItems(e.dataTransfer);
        if (!items || items.some((i) => i.type !== 'material')) return;
        const s = library.getState();
        const known = new Map([...s.materials, ...s.folderMaterials].map((m) => [m.id, m]));
        const list = items.map((i) => known.get(i.id)).filter((m): m is KbMaterialSummary => Boolean(m));
        void batch.move(list, folder.id);
        return;
      }
      if (!hasDragFiles(e.dataTransfer)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files ?? []);
      const read = bridge.droppedMediaFile
        ? files.map((f) => ({ choice: bridge.droppedMediaFile!(f), size: f.size }))
          .filter((x): x is { choice: NonNullable<typeof x.choice>; size: number } => x.choice !== null)
          .map((x) => ({ path: x.choice.path, name: x.choice.name, size: x.size }))
        : [];
      ui.getState().setAddMaterialOpen(true, { folderId: folder.id, files: read, unreadable: files.length - read.length });
    },
  };
  const className = over ? ' is-drop' : blocked ? ' is-nodrop' : '';
  return { handlers, className, reason: blocked };
}
