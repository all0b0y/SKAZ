import { useEffect, useState } from 'react';
import type { KbPage, KbPageDeletePreview } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Banner, Button, Modal, Spinner, TextField } from '../ui';
import { PageChip } from '../document/parts';
import { plural } from '../document/text';
import { useServices, useUi } from '../state/context';

/** As for materials: a name is at most 200 bytes on disk; the field stops at 200 characters. */
const MAX_TITLE_CHARS = 200;

export type PageDialog = 'rename' | 'delete' | null;

/** Rename a wiki page; the backend rewrites every [[link]] to it (B20). */
export function RenamePageDialog({ page, open, onClose, onDone }: {
  page: KbPage; open: boolean; onClose: () => void; onDone: (p: KbPage) => void;
}) {
  const { client, library } = useServices();
  const [title, setTitle] = useState(page.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setTitle(page.title); setError(null); } }, [open, page.title]);
  const save = async () => {
    const clean = title.trim();
    if (!clean) { setError('Enter a name.'); return; }
    if (clean === page.title) { onClose(); return; }
    setBusy(true);
    try {
      const next = await client.call('PATCH /kb/wiki/pages/{page_id}', { path: { page_id: page.id }, body: { title: clean } });
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
    <Modal open={open} onClose={onClose} title="Rename page" className="kb-modal--narrow" testId="rename-page" pane="rename-page">
      <form className="kb-modal__body" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <TextField label="Name" value={title} onChange={(e) => setTitle(e.target.value)} error={error} autoFocus
          maxLength={MAX_TITLE_CHARS} hint={title.length > MAX_TITLE_CHARS - 20 ? `${title.length} of ${MAX_TITLE_CHARS} characters` : undefined} />
        <p className="kb-modal__hint">Links to this page in the wiki follow the new name.</p>
        <div className="kb-modal__foot">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="fill" type="submit" busy={busy}>Rename</Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteSummary({ preview }: { preview: KbPageDeletePreview }) {
  const inNotes = preview.linking_pages.reduce((n, p) => n + p.in_your_notes, 0);
  return (
    <div className="kb-delprev">
      <ul className="kb-delprev__list">
        <li>{preview.links_unlinked === 0 ? 'No other page links here.'
          : <><b>{plural(preview.links_unlinked, 'link')}</b> to this page {preview.links_unlinked === 1 ? 'is' : 'are'} removed; the words stay.</>}</li>
        {inNotes > 0 && <li>{inNotes === 1 ? 'One of them is in your own note: it keeps its text.' : `${inNotes} of them are in your own notes: they keep their text.`}</li>}
        {preview.user_notes > 0 && (
          <li><b>{preview.user_notes === 1 ? 'Your note on this page' : `Your ${preview.user_notes} notes on this page`}</b> {preview.user_notes === 1 ? 'is' : 'are'} deleted with it.</li>
        )}
        <li>{preview.sources.length === 0 ? 'No materials are touched.'
          : preview.sources.length === 1 ? `The source “${preview.sources[0]!.title}” stays in the library.`
            : `Its ${preview.sources.length} sources stay in the library.`}</li>
      </ul>
      {preview.linking_pages.length > 0 && (
        <div className="kb-delprev__group">
          <p className="kb-delprev__head">Pages changed</p>
          <div className="kb-chips">{preview.linking_pages.map((p) => <PageChip key={p.page.id} page={p.page} />)}</div>
        </div>
      )}
    </div>
  );
}

/** Delete a page with a preview first: nothing is removed before "Delete" (B20). */
export function DeletePageDialog({ page, open, onClose }: { page: KbPage; open: boolean; onClose: () => void }) {
  const { client, library, chats } = useServices();
  const closeDoc = useUi((s) => s.closeDoc);
  const [preview, setPreview] = useState<KbPageDeletePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setPreview(null); setLoadError(null); setError(null);
    client.call('GET /kb/wiki/pages/{page_id}/delete-preview', { path: { page_id: page.id } }).then(
      (p) => { if (live) setPreview(p); },
      (e: unknown) => { if (live) setLoadError(errorText(e)); },
    );
    return () => { live = false; };
  }, [open, client, page.id]);
  const remove = async () => {
    setBusy(true);
    try {
      await client.call('DELETE /kb/wiki/pages/{page_id}', { path: { page_id: page.id } });
      onClose();
      chats.getState().forget({ page: page.id });
      closeDoc();
      void library.getState().loadContent();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Delete “${page.title}”?`} className="kb-modal--narrow" testId="delete-page" pane="delete-page">
      <div className="kb-modal__body">
        {!preview && !loadError && <div className="kb-doc__wait"><Spinner label="Checking what changes in the wiki" /></div>}
        {loadError && <Banner tone="error" title="Couldn’t check what changes.">{loadError}</Banner>}
        {preview && <DeleteSummary preview={preview} />}
        {error && <p className="kb-inline-error" role="alert">{error}</p>}
        <div className="kb-modal__foot">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon="trash" busy={busy} disabled={!preview} onClick={() => void remove()}>Delete</Button>
        </div>
      </div>
    </Modal>
  );
}
