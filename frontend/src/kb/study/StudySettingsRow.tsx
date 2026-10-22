import { useEffect, useState } from 'react';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { studyApi } from './api';

/** Settings → Wiki → Study (S8, Q14): how many new cards each folder brings into reviews per day. */
export function NewCardsRow({ label }: { label: string }) {
  const { client } = useServices();
  const [value, setValue] = useState<string>('');
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    studyApi.settings(client).then((s) => { if (live) { setSaved(s.new_per_day); setValue(String(s.new_per_day)); } },
      (e: unknown) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [client]);
  const save = async () => {
    const n = Number(value);
    if (!/^\d{1,4}$/.test(value.trim()) || !Number.isInteger(n)) {
      setError('A whole number from 0 to 9999.');
      return;
    }
    if (n === saved) { setError(null); return; }
    try {
      const s = await studyApi.setSettings(client, n);
      setSaved(s.new_per_day);
      setValue(String(s.new_per_day));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <span className={`kb-field__box kb-st-num${error ? ' has-error' : ''}`}><input className="kb-field__input" type="number" inputMode="numeric" min={0} max={9999} aria-label={label}
        value={value} disabled={saved === null && !error} onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} /></span>
      {error && <span className="kb-inline-error" role="alert">{error}</span>}
    </>
  );
}
