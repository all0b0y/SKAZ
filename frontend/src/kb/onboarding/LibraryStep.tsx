import { useState } from 'react';
import { Button, Icon, PathText } from '../ui';
import { useLibrary, useServices } from '../state/context';

export interface LibraryChoice {
  /** Folder picked in the native chooser; null = the suggested place. */
  base: string | null;
  setBase: (path: string | null) => void;
  error: string | null;
}

/** Folder row of the library step: where the library will be, and "Change…" (native chooser). */
export function LibraryPlace({ base, setBase, error, allowChange = false }: LibraryChoice & { allowChange?: boolean }) {
  const { bridge } = useServices();
  const library = useLibrary((s) => s.library);
  const ready = library?.state === 'ready';
  const shown = base ?? (ready ? library.root : library?.suggested_root);
  const choose = async () => {
    const picked = await bridge.chooseStorageRoot?.();
    if (picked) setBase(picked);
  };
  return (
    <>
      <div className="kb-srow">
        <div className="kb-srow__text">
          <div className="kb-srow__label">Folder</div>
          <div className="kb-srow__hint">
            {base ? 'SKAZ makes its own SKAZ folder inside the one you chose.'
              : ready ? 'Connected. Materials and wiki live here.' : 'Suggested place, in Documents.'}
          </div>
        </div>
        <div className="kb-srow__control">
          <PathText path={shown ?? '—'} testId="library-path" />
          {ready && !base && <span className="kb-ok"><Icon name="check" size={13} />Connected</span>}
          {(!ready || allowChange) && bridge.chooseStorageRoot && (
            <Button size="sm" onClick={() => void choose()}>Change…</Button>
          )}
        </div>
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </>
  );
}

/** Library step state + the one action that creates it (POST /kb/library). */
export function useLibraryChoice() {
  const { library: store } = useServices();
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connect = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const result = await store.getState().connect(base);
    setBusy(false);
    if (!result.ok) { setError(result.error); return false; }
    if (result.value.state !== 'ready') { setError(result.value.reason ?? 'The library couldn’t be opened.'); return false; }
    return true;
  };
  return { base, setBase: (p: string | null) => { setBase(p); setError(null); }, error, busy, connect };
}
