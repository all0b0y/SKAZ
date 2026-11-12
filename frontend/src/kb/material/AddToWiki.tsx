import { useRef, useState } from 'react';
import type { KbClient } from '../api/client';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { Button } from '../ui';
import './addToWiki.css';

/** The existing ingest action shared by the document panel and Explore materials. */
export function requestWikiIngest(client: Pick<KbClient, 'call'>, materialId: string, notesOnly = false) {
  return client.call(notesOnly ? 'POST /kb/materials/{material_id}/notes' : 'POST /kb/materials/{material_id}/ingest',
    { path: { material_id: materialId } });
}

export function AddToWiki({ materialId, onAdded }: { materialId: string; onAdded?: () => void }) {
  const { client, library } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const add = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      await requestWikiIngest(client, materialId);
      void library.getState().loadContent(); onAdded?.();
    } catch (e) { setError(errorText(e)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <span className="kb-add-to-wiki" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
    <Button size="sm" variant="quiet" busy={busy} onClick={() => void add()}>Add to wiki</Button>
    {error && <span role="alert" className="kb-inline-error">{error}</span>}
  </span>;
}
