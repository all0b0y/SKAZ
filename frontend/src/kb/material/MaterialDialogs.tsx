import { useEffect, useState, type ReactNode } from 'react';
import type { KbDeletePreview, KbMaterial } from '../api/b2-u3';
import { errorText } from '../api/client';
import { Banner, Button, Icon, Modal, Spinner, TextField } from '../ui';
import { PageChip, useFolderTone } from '../document/parts';
import { plural } from '../document/text';
import { useLibrary, useServices, useUi } from '../state/context';

export type MaterialDialog = 'rename' | 'move' | 'delete' | null;

function Footer({ children }: { children: ReactNode }) {
  return <div className="kb-modal__foot">{children}</div>;
}

export function RenameDialog({ material, open, onClose, onDone }: {
  material: KbMaterial; open: boolean; onClose: () => void; onDone: (m: KbMaterial) => void;
}) {
  const { u3, library } = useServices();
  const [title, setTitle] = useState(material.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setTitle(material.title); setError(null); } }, [open, material.title]);
  const save = async () => {
    const clean = title.trim();
    if (!clean) { setError('Enter a name.'); return; }
    if (clean === material.title) { onClose(); return; }
    setBusy(true);
    try {
      const next = await u3.call('PATCH /kb/materials/{material_id}', { path: { material_id: material.id }, body: { title: clean } });
      void library.getState().loadContent();
      onDone(next);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Rename material" className="kb-modal--narrow" testId="rename-material" pane="rename-material">
      <form className="kb-modal__body" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <TextField label="Name" value={title} onChange={(e) => setTitle(e.target.value)} error={error} autoFocus />
        <p className="kb-modal__hint">Wiki links to this material follow the new name.</p>
        <Footer>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="fill" type="submit" busy={busy}>Rename</Button>
        </Footer>
      </form>
    </Modal>
  );
}

export function MoveDialog({ material, open, onClose, onDone }: {
  material: KbMaterial; open: boolean; onClose: () => void; onDone: (m: KbMaterial) => void;
}) {
  const { u3, library } = useServices();
  const folders = useLibrary((s) => s.folders);
  const tone = useFolderTone();
  const [choice, setChoice] = useState(material.folder_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setChoice(material.folder_id); setError(null); } }, [open, material.folder_id]);
  const move = async () => {
    if (choice === material.folder_id) { onClose(); return; }
    setBusy(true);
    try {
      const next = await u3.call('PATCH /kb/materials/{material_id}', { path: { material_id: material.id }, body: { folder_id: choice } });
      void library.getState().loadContent();
      onDone(next);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Move to folder" className="kb-modal--narrow" testId="move-material" pane="move-material">
      <div className="kb-modal__body">
        <div role="radiogroup" aria-label="Folder" className="kb-choices">
          {folders.map((f) => (
            <label key={f.id} className={`kb-choice${choice === f.id ? ' is-on' : ''}`}>
              <input type="radio" name="kb-move-folder" value={f.id} checked={choice === f.id} onChange={() => setChoice(f.id)} />
              <Icon name={f.system ? 'inbox' : 'folder'} size={15} />
              <span className="kb-choice__text">{f.name}</span>
              {tone(f.id) && <span className="kb-fdot" style={{ background: tone(f.id) }} aria-hidden="true" />}
              {f.id === material.folder_id && <span className="kb-choice__note">current</span>}
            </label>
          ))}
        </div>
        {error && <p className="kb-inline-error" role="alert">{error}</p>}
        <Footer>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="fill" busy={busy} onClick={() => void move()} disabled={choice === material.folder_id}>Move</Button>
        </Footer>
      </div>
    </Modal>
  );
}

function PreviewSummary({ preview }: { preview: KbDeletePreview }) {
  return (
    <div className="kb-delprev">
      <ul className="kb-delprev__list">
        <li><b>{plural(preview.claims_removed, 'statement')}</b> from this material leave the wiki.</li>
        {preview.claims_kept > 0 && <li>{plural(preview.claims_kept, 'statement')} stay: other sources support them.</li>}
        {preview.connections_removed > 0 && <li>{plural(preview.connections_removed, 'connection')} between pages go away.</li>}
        <li>{preview.user_notes_kept === 1 ? 'Your note on these pages stays untouched.' : preview.user_notes_kept > 1 ? `Your ${preview.user_notes_kept} notes on these pages stay untouched.` : 'Your notes are never touched.'}</li>
      </ul>
      {preview.pages_removed.length > 0 && (
        <div className="kb-delprev__group">
          <p className="kb-delprev__head">Pages removed</p>
          <div className="kb-chips">{preview.pages_removed.map((p) => <PageChip key={p.id} page={p} />)}</div>
        </div>
      )}
      {preview.pages_changed.length > 0 && (
        <div className="kb-delprev__group">
          <p className="kb-delprev__head">Pages changed</p>
          <div className="kb-chips">{preview.pages_changed.map((p) => <PageChip key={p.id} page={p} />)}</div>
        </div>
      )}
    </div>
  );
}

/** Delete with a preview of what changes in the wiki (decision 7); nothing is removed before "Delete". */
export function DeleteDialog({ material, open, onClose }: { material: KbMaterial; open: boolean; onClose: () => void }) {
  const { u3, library } = useServices();
  const closeDoc = useUi((s) => s.closeDoc);
  const [preview, setPreview] = useState<KbDeletePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setPreview(null); setLoadError(null); setError(null);
    u3.call('GET /kb/materials/{material_id}/delete-preview', { path: { material_id: material.id } }).then(
      (p) => { if (live) setPreview(p); },
      (e: unknown) => { if (live) setLoadError(errorText(e)); },
    );
    return () => { live = false; };
  }, [open, u3, material.id]);
  const remove = async () => {
    setBusy(true);
    try {
      await u3.call('DELETE /kb/materials/{material_id}', { path: { material_id: material.id } });
      void library.getState().loadContent();
      onClose();
      closeDoc();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Delete “${material.title}”?`} className="kb-modal--narrow" testId="delete-material" pane="delete-material">
      <div className="kb-modal__body">
        {!preview && !loadError && <div className="kb-doc__wait"><Spinner label="Checking what changes in the wiki" /></div>}
        {loadError && <Banner tone="error" title="Couldn’t check what changes.">{loadError}</Banner>}
        {preview && <PreviewSummary preview={preview} />}
        {error && <p className="kb-inline-error" role="alert">{error}</p>}
        <Footer>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon="trash" busy={busy} disabled={!preview} onClick={() => void remove()}>Delete</Button>
        </Footer>
      </div>
    </Modal>
  );
}
