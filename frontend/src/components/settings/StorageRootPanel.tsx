import { useEffect, useRef, useState } from 'react';
import { ApiClient } from '../../api/client';
import type { StorageRootView } from '../../api/types';
import { Button } from '../ui/Button';
import { PhysicalStoragePanel } from './PhysicalStoragePanel';
import './storageRootPanel.css';

const unknownOutcome = 'Saving was not confirmed. Check the current root before retrying.';

export function StorageRootPanel({ capturing }: { capturing: boolean }) {
  const [view, setView] = useState<StorageRootView | null>(null);
  const [candidate, setCandidate] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const lifecycle = useRef({ alive: true });
  const running = useRef(false);

  const read = async () => {
    const next = await new ApiClient(window.skaz).getStorageRoot();
    if (!next || next.mode !== 'markdown_projection' || typeof next.suggested_root !== 'string'
      || (next.root !== null && typeof next.root !== 'string')
      || typeof next.change_locked !== 'boolean' || typeof next.managed !== 'boolean') {
      throw new Error('Invalid storage status');
    }
    return next;
  };

  useEffect(() => {
    const scope = { alive: true };
    lifecycle.current = scope;
    void read().then((next) => { if (scope.alive) setView(next); }, () => {
      if (scope.alive) setError('Could not read the Markdown root.');
    });
    return () => { scope.alive = false; };
  }, []);

  const run = async (operation: 'choose' | 'save' | 'read') => {
    if (running.current) return;
    const scope = lifecycle.current;
    running.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      if (operation === 'choose') {
        if (!window.skaz.chooseStorageRoot) throw new Error('Chooser unavailable');
        const selected = await window.skaz.chooseStorageRoot();
        if (scope.alive && selected !== null) setCandidate(selected);
      } else {
        if (operation === 'save') {
          if (!view || candidate === undefined || capturing || view.change_locked) return;
          // Never automatically retry a PUT, including when its response is lost.
          await new ApiClient(window.skaz).updateStorageRoot(candidate, view.root);
        }
        const next = await read();
        if (scope.alive) {
          setView(next); setCandidate(undefined);
          if (operation === 'save') {
            if (next.root === candidate) setMessage('Markdown root saved.');
            else setError('The root changed. Showing the current setting.');
          }
        }
        window.dispatchEvent(new Event('skaz-storage-root-changed'));
      }
    } catch {
      if (scope.alive) {
        if (operation !== 'choose') { setView(null); setCandidate(undefined); }
        setError(operation === 'choose' ? 'Could not open the folder picker.' : unknownOutcome);
      }
    } finally {
      running.current = false;
      if (scope.alive) setBusy(false);
    }
  };

  const disabled = busy || capturing || !view || view.change_locked;
  return <><section className="settings-section storage-root" aria-label="Markdown root">
    <h3 className="settings-section__title">Files</h3>
    <p>File root. Until physical mode below is enabled separately, only Markdown is saved here.
      The database stays in internal storage.</p>
    {view && <>
      <p>{view.root === null ? 'Markdown projection is off.' : 'Current Markdown root:'}</p>
      {view.root && <code className="storage-root__path">{view.root}</code>}
      <p>Suggested root: <code className="storage-root__path">{view.suggested_root}</code></p>
      {view.change_locked && <p role="status">{view.managed
        ? 'The root was set when the app launched; it cannot be changed here.'
        : 'The root is already in use. Changing or disabling it is blocked until a safe move.'}</p>}
    </>}
    {capturing && <p>Stop recording before changing the root.</p>}
    <div className="storage-root__actions">
      <Button disabled={disabled} onClick={() => void run('choose')}>Choose folder…</Button>
      <Button disabled={disabled} onClick={() => { setCandidate(view!.suggested_root); setMessage(''); }}>
        Use Documents/SKAZ
      </Button>
      {view?.root && <Button disabled={disabled} onClick={() => setCandidate(null)}>Turn off projection</Button>}
    </div>
    {candidate !== undefined && <fieldset disabled={disabled}>
      <legend>{candidate === null ? 'Turn off Markdown projection?' : 'Confirm the chosen root?'}</legend>
      {candidate !== null && <code className="storage-root__path">{candidate}</code>}
      <p>This saves the setting on its own. Files are not moved or imported.
        After confirming, Pause/Stop and Notes edits save Markdown to the chosen root.
        Existing text appears when file saving is retried explicitly or on the next edit.</p>
      <div className="storage-root__actions">
        <Button onClick={() => void run('save')}>Confirm Markdown root</Button>
        <Button onClick={() => setCandidate(undefined)}>Cancel</Button>
      </div>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <Button disabled={busy} onClick={() => void run('read')}>Check current root</Button>
  </section><PhysicalStoragePanel capturing={capturing} /></>;
}
