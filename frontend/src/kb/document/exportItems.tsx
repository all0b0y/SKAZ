import { useState, type ReactNode } from 'react';
import { errorText } from '../api/client';
import { Button, Modal } from '../ui';
import { useServices } from '../state/context';
import { countOf, resultText } from '../ui/listSelection';

export interface ExportRef { type: 'chat' | 'page' | 'material'; id: string }

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/**
 * Export .md of chosen chats, pages and materials (0.3.1 F5): the folder comes from the native
 * chooser and is checked like the whole-library export (`GET /kb/export/target`: never inside the
 * library; a non-empty one only after a yes), then `POST /kb/export/items` writes one file per item.
 * `run` is null where the host can't choose a folder (outside the desktop app).
 */
export function useExportItems(): { run: ((items: ExportRef[]) => void) | null; dialog: ReactNode } {
  const { bridge, client, ui } = useServices();
  const [confirm, setConfirm] = useState<{ path: string; entries: number; items: ExportRef[] } | null>(null);
  const toast = ui.getState().showToast;

  const write = async (path: string, items: ExportRef[], overwrite: boolean) => {
    try {
      const res = await client.call('POST /kb/export/items', { body: { path, items, overwrite } });
      const result = { done: res.written.map((w) => w.id), skipped: res.skipped.map((s) => ({ id: s.id, reason: s.reason })) };
      const where = folderName(path);
      toast({
        text: res.skipped.length ? `${resultText('Exported', result, 'file')} · in «${where}»` : `Exported ${countOf(res.written.length, 'file')} to «${where}»`,
        tone: res.skipped.length ? 'problem' : 'done',
        action: bridge.showInFinder && res.written.length
          ? { label: 'Show in Finder', run: () => void bridge.showInFinder!({ kind: 'export', path }).catch(() => false) } : undefined,
      });
    } catch (error) {
      toast({ text: `Couldn’t export: ${errorText(error)}`, tone: 'problem' });
    }
  };

  const run = async (items: ExportRef[]) => {
    if (!items.length || !bridge.chooseExportFolder) return;
    const path = await bridge.chooseExportFolder().catch(() => null);
    if (!path) return;
    try {
      const target = await client.call('GET /kb/export/target', { query: { path } });
      if (target.reason) { toast({ text: target.reason, tone: 'problem' }); return; }
      if (target.non_empty) { setConfirm({ path: target.path, entries: target.entries, items }); return; }
      await write(target.path, items, false);
    } catch (error) {
      toast({ text: `Couldn’t export: ${errorText(error)}`, tone: 'problem' });
    }
  };

  const dialog = (
    <Modal open={confirm !== null} onClose={() => setConfirm(null)} title="Export into a folder that isn’t empty?" className="kb-confirm" testId="confirm-export-items">
      {confirm && (
        <>
          <div className="kb-confirm__body">
            <p>“{folderName(confirm.path)}” already holds {confirm.entries === 1 ? '1 item' : `${confirm.entries} items`}.</p>
            <p className="kb-muted">Files with the same names are replaced; everything else in the folder stays.</p>
          </div>
          <footer className="kb-confirm__foot">
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="fill" onClick={() => { const c = confirm; setConfirm(null); void write(c.path, c.items, true); }}>Export here</Button>
          </footer>
        </>
      )}
    </Modal>
  );
  return { run: bridge.chooseExportFolder ? (items) => void run(items) : null, dialog };
}
