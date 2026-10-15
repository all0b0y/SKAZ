import { useRef, useState } from 'react';
import type { KbFolder, KbMaterialSummary } from '../../api/kb/types.gen';
import { Banner, Button, EmptyState, Icon, IconButton, Menu, Spinner } from '../ui';
import { useLibrary, useServices, useUi } from '../state/context';
import { KIND_ICON, folderTone } from './materialMeta';
import { NameField } from './NameField';

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

function MaterialRow({ material, tone, meta }: { material: KbMaterialSummary; tone?: string; meta?: string }) {
  const openDoc = useUi((s) => s.openDoc);
  const current = useUi((s) => s.docMaterialId === material.id);
  return (
    <li>
      <button
        type="button"
        className={`kb-row${current ? ' is-current' : ''}`}
        aria-current={current ? 'true' : undefined}
        onClick={() => openDoc(material.id)}
      >
        <Icon name={KIND_ICON[material.kind]} size={16} className="kb-row__icon" />
        <span className="kb-row__text">{material.title}</span>
        {tone && <span className="kb-fdot" style={{ background: tone }} aria-hidden="true" />}
        {meta && <span className="kb-row__meta">{meta}</span>}
      </button>
    </li>
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
        <ul className="kb-list" aria-labelledby="kb-recent">
          {materials.slice(0, RECENT).map((m) => (
            <MaterialRow key={m.id} material={m} tone={toneOf(m.folder_id)} meta={systemName(m.folder_id)} />
          ))}
        </ul>
      )}

      <div className="kb-subhead kb-subhead--row">
        <h3 className="kb-subhead__text" id="kb-folders">Folders</h3>
        <IconButton icon="folderPlus" label="New folder" size="sm" onClick={() => setCreating(true)} disabled={creating} />
      </div>
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
        <button type="button" className="kb-row kb-row--folder" onClick={() => void store.getState().openFolder(folder.id)}>
          <Icon name={folder.system ? 'inbox' : 'folder'} size={16} className="kb-row__icon" />
          <span className="kb-row__text">{folder.name}</span>
          {tone && <span className="kb-fdot" style={{ background: tone }} aria-hidden="true" />}
          <span className="kb-row__count" aria-label={`${folder.material_count} materials`}>{folder.material_count}</span>
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
        <ul className="kb-list" aria-labelledby="kb-folder-title">
          {items.map((m) => <MaterialRow key={m.id} material={m} tone={tone} />)}
        </ul>
      )}
    </div>
  );
}
