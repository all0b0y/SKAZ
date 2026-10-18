import { useEffect, useState } from 'react';
import type { KbMaterialSummary } from '../../api/kb/types.gen';
import { Button, Icon, IconButton, Modal } from '../ui';
import { useFolderTone } from '../document/parts';
import { plural } from '../document/text';
import { useLibrary, useServices, useUi } from '../state/context';
import { addMaterialsToWiki, deleteMaterials, moveMaterials, outcomeText } from './bulk';

/**
 * The bar under "All materials" while rows are selected (FEAT-2): how many, and what to do with
 * them all at once. Each action reports what it did; failures keep their rows selected.
 */
export function SelectionBar({ selected, onClear, onKeep }: {
  selected: KbMaterialSummary[];
  onClear: () => void;
  /** Keep only these ids selected (the ones an action couldn't finish). */
  onKeep: (ids: string[]) => void;
}) {
  const { client, library, ui, composer } = useServices();
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<'wiki' | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => { setNote(null); }, [selected.length]);
  if (!selected.length) return null;
  const ids = selected.map((m) => m.id);

  const addToWiki = async () => {
    setBusy('wiki');
    const outcome = await addMaterialsToWiki(client, ids);
    setBusy(null);
    setNote({ text: outcomeText(outcome, 'queued for the wiki'), error: outcome.failed.length > 0 });
    void library.getState().loadContent();
  };
  const ask = () => {
    const s = ui.getState();
    if (s.center !== 'chat') s.showCenter('chat');
    composer.getState().push(selected.map((m) => ({ kind: 'mention' as const, ref: { type: 'material' as const, id: m.id, title: m.title } })), { focus: true });
    onClear();
  };

  return (
    <div className="kb-bulkbar" role="toolbar" aria-label="Selected materials">
      <span className="kb-bulkbar__count">{plural(selected.length, 'material')} selected</span>
      <Button size="sm" variant="quiet" icon="folder" onClick={() => setMoving(true)}>Move to…</Button>
      <Button size="sm" variant="quiet" icon="concept" busy={busy === 'wiki'} onClick={() => void addToWiki()}>Add to wiki</Button>
      <Button size="sm" variant="quiet" icon="mention" onClick={ask}>Ask</Button>
      <Button size="sm" variant="quiet" icon="trash" onClick={() => setDeleting(true)}>Delete</Button>
      {note && <span className={note.error ? 'kb-inline-error kb-inline-error--flat' : 'kb-muted'} role="status">{note.text}</span>}
      <span className="kb-head__spacer" />
      <IconButton icon="close" size="sm" label="Clear selection" onClick={onClear} />
      <BulkMoveDialog open={moving} selected={selected} onClose={() => setMoving(false)}
        onDone={(failed, text) => { setNote({ text, error: failed.length > 0 }); if (failed.length) onKeep(failed); else onClear(); }} />
      <BulkDeleteDialog open={deleting} selected={selected} onClose={() => setDeleting(false)}
        onDone={(failed, text) => { setNote({ text, error: failed.length > 0 }); if (failed.length) onKeep(failed); else onClear(); }} />
    </div>
  );
}

function BulkMoveDialog({ open, selected, onClose, onDone }: {
  open: boolean;
  selected: KbMaterialSummary[];
  onClose: () => void;
  onDone: (failed: string[], text: string) => void;
}) {
  const { client, library } = useServices();
  const folders = useLibrary((s) => s.folders);
  const tone = useFolderTone();
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setChoice(null); }, [open]);
  const move = async () => {
    if (!choice) return;
    setBusy(true);
    const ids = selected.filter((m) => m.folder_id !== choice).map((m) => m.id);
    const outcome = await moveMaterials(client, ids, choice);
    setBusy(false);
    void library.getState().loadContent();
    onClose();
    onDone(outcome.failed.map((f) => f.id), outcomeText(outcome, 'moved') || 'They are already in that folder.');
  };
  return (
    <Modal open={open} onClose={onClose} title={`Move ${plural(selected.length, 'material')} to folder`} className="kb-modal--narrow" testId="move-materials" pane="move-materials">
      <div className="kb-modal__body">
        <div role="radiogroup" aria-label="Folder" className="kb-choices">
          {folders.map((f) => (
            <label key={f.id} className={`kb-choice${choice === f.id ? ' is-on' : ''}`}>
              <input type="radio" name="kb-bulk-folder" value={f.id} checked={choice === f.id} onChange={() => setChoice(f.id)} />
              <Icon name={f.system ? 'inbox' : 'folder'} size={15} />
              <span className="kb-choice__text">{f.name}</span>
              {tone(f.id) && <span className="kb-fdot" style={{ background: tone(f.id) }} aria-hidden="true" />}
            </label>
          ))}
        </div>
        <div className="kb-modal__foot">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="fill" busy={busy} disabled={!choice} onClick={() => void move()}>Move</Button>
        </div>
      </div>
    </Modal>
  );
}

function BulkDeleteDialog({ open, selected, onClose, onDone }: {
  open: boolean;
  selected: KbMaterialSummary[];
  onClose: () => void;
  onDone: (failed: string[], text: string) => void;
}) {
  const { client, library } = useServices();
  const docId = useUi((s) => s.docMaterialId);
  const closeDoc = useUi((s) => s.closeDoc);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    const outcome = await deleteMaterials(client, selected.map((m) => m.id));
    setBusy(false);
    for (const id of outcome.done) void library.getState().forgetMaterial(id);
    if (docId && outcome.done.includes(docId)) closeDoc();
    onClose();
    onDone(outcome.failed.map((f) => f.id), outcomeText(outcome, 'deleted'));
  };
  return (
    <Modal open={open} onClose={onClose} title={`Delete ${plural(selected.length, 'material')}?`} className="kb-modal--narrow" testId="delete-materials" pane="delete-materials">
      <div className="kb-modal__body">
        <p>Each material is deleted the same way as on its own page: its files leave the library, and the
          wiki statements only it supported are taken down.</p>
        <ul className="kb-delprev__list">
          {selected.slice(0, 8).map((m) => <li key={m.id}>{m.title}</li>)}
          {selected.length > 8 && <li className="kb-muted">and {selected.length - 8} more</li>}
        </ul>
        <div className="kb-modal__foot">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon="trash" busy={busy} onClick={() => void remove()}>Delete</Button>
        </div>
      </div>
    </Modal>
  );
}
