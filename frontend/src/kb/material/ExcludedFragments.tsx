import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KbMaterialGuard } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Banner, Button, Icon, Spinner } from '../ui';
import { useServices } from '../state/context';

export interface MaterialGuardState {
  guard: KbMaterialGuard | null;
  error: string | null;
  /** Segments the guard left out of processing: the text marks them where they are. */
  excludedSegs: ReadonlySet<number>;
  set: (guard: KbMaterialGuard) => void;
}

const NONE: ReadonlySet<number> = new Set();

/**
 * What the guard excluded from this material (decision 41). Read as soon as the material says it
 * has excluded fragments, so the text can mark them in place; read again when that count changes
 * (a restore, a reprocess). Until the new answer comes the last one of this material stays shown.
 */
export function useMaterialGuard(materialId: string, count: number): MaterialGuardState {
  const { client } = useServices();
  const [state, setState] = useState<{ materialId: string; guard: KbMaterialGuard | null; error: string | null } | null>(null);

  useEffect(() => {
    if (count <= 0) return undefined;
    let live = true;
    client.call('GET /kb/materials/{material_id}/excluded', { path: { material_id: materialId } }).then(
      (guard) => { if (live) setState({ materialId, guard, error: null }); },
      (e: unknown) => { if (live) setState({ materialId, guard: null, error: errorText(e) }); },
    );
    return () => { live = false; };
  }, [client, materialId, count]);

  const current = count > 0 && state?.materialId === materialId ? state : null;
  const guard = current?.guard ?? null;
  const excludedSegs = useMemo(() => (guard ? new Set(guard.excluded.map((x) => x.seg)) : NONE), [guard]);
  const set = useCallback((next: KbMaterialGuard) => setState({ materialId, guard: next, error: null }), [materialId]);
  return { guard, error: current?.error ?? null, excludedSegs, set };
}

/**
 * "Excluded fragments: N" (decision 41): what the guard took out of processing, where it was,
 * and "Restore" — the backend reprocesses the source with that fragment.
 */
export function ExcludedFragments({ materialId, count, guard: state, onRestored }: {
  materialId: string;
  count: number;
  guard: MaterialGuardState;
  onRestored: () => void;
}) {
  const { client } = useServices();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const { guard } = state;
  const shownError = error ?? state.error;

  const restore = async (seg: number) => {
    setBusy(seg);
    setError(null);
    try {
      state.set(await client.call('POST /kb/materials/{material_id}/excluded/{seg}/restore', { path: { material_id: materialId, seg } }));
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
      <button type="button" className="kb-excl__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="privacy" size={14} />
        <span>Excluded fragments: {count}</span>
        <Icon name="chevronDown" size={12} className={open ? 'kb-rot' : undefined} />
      </button>
      {open && (
        <div className="kb-excl__body">
          {!guard && !shownError && <Spinner label="Loading excluded fragments" size="sm" />}
          {shownError && <Banner tone="error" title="Couldn’t load them.">{shownError}</Banner>}
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
