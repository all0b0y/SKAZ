import { useEffect, useState } from 'react';
import { ApiClient, type StorageLayout } from '../../api/client';
import { Button } from '../ui/Button';

export function PhysicalStoragePanel({ capturing }: { capturing: boolean }) {
  const [view, setView] = useState<StorageLayout | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [move, setMove] = useState<{ root: string; previous: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void new ApiClient(window.skaz).getStorageLayout().then((next) => {
      if (alive) setView(next);
    }, () => { if (alive) setError('Could not read the file mode.'); });
    return () => { alive = false; };
  }, []);
  const run = async (action: 'read' | 'enable' | 'recover' | 'choose' | 'move') => {
    if (busy) return;
    setBusy(true); setError('');
    const api = new ApiClient(window.skaz);
    try {
      if (action === 'choose') {
        const root = await api.getStorageRoot();
        if (root.managed || !root.root || !window.skaz.chooseStorageRoot) throw new Error('Managed root');
        const selected = await window.skaz.chooseStorageRoot();
        if (selected) setMove({ root: selected, previous: root.root });
        return;
      }
      if (action === 'move' && move) await api.moveStorageRoot(move.root, move.previous);
      if (action === 'enable') await api.enableStorageLayout();
      if (action === 'recover') await api.recoverStorage();
      setView(await api.getStorageLayout()); setConfirm(false); setMove(null);
      window.dispatchEvent(new Event('skaz-storage-root-changed'));
    } catch {
      setView(null); setMove(null);
      setError('The operation was not confirmed. Check the state. Enabling requires a chosen root and an empty session list; existing recordings are never deleted automatically.');
    } finally { setBusy(false); }
  };
  return <section className="settings-section storage-root" aria-label="Physical storage">
    <h3 className="settings-section__title">Physical session folders</h3>
    <p>Groups and sessions are stored in the chosen root. Original audio goes to audio/ inside each session.
      The database stays in internal storage. “All” is a virtual list; Ungrouped is a folder.</p>
    {view?.enabled ? <p role="status">File mode is on. Groups are saved in the database, not in the browser.</p>
      : <Button disabled={!view || busy || capturing} onClick={() => setConfirm(true)}>Enable file mode…</Button>}
    {confirm && <fieldset disabled={busy || capturing}>
      <legend>Switch to physical folders?</legend>
      <p>First choose a root and explicitly delete earlier sessions if you no longer need them.
        There is no automatic migration or deletion. File mode cannot be turned off after switching.</p>
      <Button onClick={() => void run('enable')}>Confirm file mode</Button>
      <Button onClick={() => setConfirm(false)}>Cancel</Button>
    </fieldset>}
    {view?.pending && <>
      <p role="alert">A file operation is unfinished ({view.pending.kind}, {view.pending.phase}).
        Recording and further moves are blocked. Recovery continues the operation,
        it does not undo a deletion. If files were changed externally, they are kept for manual review.</p>
      <Button disabled={busy || capturing} onClick={() => void run('recover')}>Continue recovery</Button>
    </>}
    {view?.enabled && !view.pending && <Button disabled={busy || capturing} onClick={() => void run('choose')}>
      Move sessions to another root…
    </Button>}
    {move && <fieldset disabled={busy || capturing}>
      <legend>Confirm moving sessions?</legend>
      <code className="storage-root__path">{move.root}</code>
      <p>Audio, transcripts and notes of all sessions are moved. Other files in the root and saved archives
        stay where they are. Moving between disks is not supported; occupied folders are not replaced.</p>
      <Button onClick={() => void run('move')}>Confirm move</Button>
      <Button onClick={() => setMove(null)}>Cancel</Button>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    <Button disabled={busy} onClick={() => void run('read')}>Check file mode</Button>
  </section>;
}
