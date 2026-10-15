import { useState } from 'react';
import type { KbMaterialGuard } from '../api/b2-u3';
import { errorText } from '../api/client';
import { Banner, Button, Icon, Spinner } from '../ui';
import { useServices } from '../state/context';

/**
 * "Excluded fragments: N" (decision 41): what the guard took out of processing, where it was,
 * and "Restore" — the backend reprocesses the source with that fragment.
 */
export function ExcludedFragments({ materialId, count, onRestored }: { materialId: string; count: number; onRestored: () => void }) {
  const { u3 } = useServices();
  const [open, setOpen] = useState(false);
  const [guard, setGuard] = useState<KbMaterialGuard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !guard) {
      setError(null);
      u3.call('GET /kb/materials/{material_id}/excluded', { path: { material_id: materialId } }).then(setGuard, (e: unknown) => setError(errorText(e)));
    }
  };
  const restore = async (seg: number) => {
    setBusy(seg);
    setError(null);
    try {
      setGuard(await u3.call('POST /kb/materials/{material_id}/excluded/{seg}/restore', { path: { material_id: materialId, seg: String(seg) } }));
      onRestored();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  if (count <= 0) return null;
  return (
    <div className="kb-excl">
      <button type="button" className="kb-excl__toggle" aria-expanded={open} onClick={toggle}>
        <Icon name="privacy" size={14} />
        <span>Excluded fragments: {count}</span>
        <Icon name="chevronDown" size={12} className={open ? 'kb-rot' : undefined} />
      </button>
      {open && (
        <div className="kb-excl__body">
          {!guard && !error && <Spinner label="Loading excluded fragments" size="sm" />}
          {error && <Banner tone="error" title="Couldn’t load them.">{error}</Banner>}
          {guard?.excluded.length === 0 && <p className="kb-muted">Nothing is excluded now.</p>}
          {guard?.excluded.map((x) => (
            <div key={x.id} className="kb-excl__item">
              <p className="kb-excl__where">{x.location.label} · {x.reason}</p>
              <p className="kb-excl__text">{x.found}</p>
              <Button size="sm" variant="outline" icon="retry" busy={busy === x.seg} onClick={() => void restore(x.seg)}>
                Not an instruction — restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
