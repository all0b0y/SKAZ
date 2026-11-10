import { useEffect, useState } from 'react';
import type { KbReadMark } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { READ_MARKS, READ_MARK_TEXT, type ReadMarkValue } from '../explore/finding/labels';
import { useMarksClients } from './marksClients';
import './marks.css';

/**
 * N4-11: at the end of a material, four quiet marks — Useful method · Changed my view · Already knew this ·
 * Not for me. One per material; a second click on the chosen one removes it. The mark is a fact the reader
 * stated, not a score: nothing is inferred from it here.
 */
export function ReadMarks({ materialId }: { materialId: string }) {
  const { areas } = useMarksClients();
  const [value, setValue] = useState<ReadMarkValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setValue(null);
    setError(null);
    // The current mark is an extra: when it cannot be read the chips are simply unset.
    areas.read_mark(materialId).then((r: KbReadMark) => { if (live) setValue(r.value); }, () => undefined);
    return () => { live = false; };
  }, [areas, materialId]);

  const choose = async (next: ReadMarkValue) => {
    setBusy(true);
    setError(null);
    try {
      const res = value === next ? await areas.remove_read_mark(materialId) : await areas.set_read_mark(materialId, { value: next });
      setValue(res.value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kb-readmarks">
      <div className="kb-readmarks__row" role="group" aria-label="Your read mark">
        {READ_MARKS.map((v) => (
          <button key={v} type="button" className="kb-readmarks__mark" aria-pressed={value === v} disabled={busy} onClick={() => void choose(v)}>
            {READ_MARK_TEXT[v]}
          </button>
        ))}
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </div>
  );
}
