import { useEffect, useRef, useState } from 'react';
import { useLibrary, useServices, useUi } from '../state/context';
import { errorText } from '../api/client';
import { Button } from '../ui';

export function ExploreReminder({ active = true }: { active?: boolean }) {
  const { client, library } = useServices();
  const revision = useLibrary((s) => s.revision);
  const opened = useUi((s) => s.docMaterialId);
  const [ids, setIds] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void client.call('GET /kb/materials-activity/explore-unused').then(
      (result) => { if (live) setIds(result.material_ids); },
      () => { if (live) setIds([]); },
    );
    return () => { live = false; };
  }, [client, revision, opened, refresh, active]);

  const act = async (remove: boolean) => {
    if (pending.current) return;
    const snapshot = [...ids];
    pending.current = true; setBusy(true); setError(null);
    try {
      if (remove) {
        // Recheck this snapshot: new arrivals, recently opened and wiki materials stay untouched.
        const latest = await client.call('GET /kb/materials-activity/explore-unused');
        const eligible = new Set(latest.material_ids);
        for (const id of snapshot.filter((id) => eligible.has(id))) {
          await client.call('DELETE /kb/materials/{material_id}', { path: { material_id: id } });
          void library.getState().forgetMaterial(id);
        }
      } else {
        for (let start = 0; start < snapshot.length; start += 1000) {
          await client.call('POST /kb/materials-activity/explore-unused/keep', { body: { material_ids: snapshot.slice(start, start + 1000) } });
        }
      }
      setIds([]);
      void library.getState().loadContent();
    } catch (e) { setError(errorText(e)); }
    finally { pending.current = false; setBusy(false); setRefresh((n) => n + 1); }
  };
  if (!active || (!ids.length && !error)) return null;
  return <div className="kb-side__note kb-muted">
    {ids.length > 0 && <>
      <span>{ids.length} {ids.length === 1 ? 'paper' : 'papers'} from Explore unused for 30 days</span>
      {' — '}<Button size="sm" variant="quiet" disabled={busy} onClick={() => void act(true)}>Remove</Button>
      {' · '}<Button size="sm" variant="quiet" disabled={busy} onClick={() => void act(false)}>Keep</Button>
    </>}
    {error && <p role="alert" className="kb-inline-error">{error}</p>}
  </div>;
}
