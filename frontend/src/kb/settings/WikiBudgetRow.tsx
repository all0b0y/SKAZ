import { useEffect, useState } from 'react';
import { useServices, useSettings } from '../state/context';

/** The wiki budget's units, as the user reads them: `2M`, `1.2M`, `50K` (characters). */
export function charactersLabel(count: number): string {
  for (const [size, suffix] of [[1_000_000, 'M'], [1_000, 'K']] as const) {
    if (count >= size) return `${Number((count / size).toFixed(1))}${suffix}`;
  }
  return String(count);
}

const MIN_MILLIONS = 0.01;
const MAX_MILLIONS = 1000;

/**
 * Settings → Models → Wiki budget per material (C1-d, user decisions 14–15, 2026-10-20): characters
 * sent to and received from the model for one material, its connections included. When a material
 * reaches it, its processing pauses with Continue. Entered in millions, shown as "1.2M characters".
 */
export function WikiBudgetRow({ label }: { label: string }) {
  const { settings } = useServices();
  const wiki = useSettings((s) => s.wiki);
  const saved = wiki.value?.wiki_budget_characters ?? null;
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (saved !== null) setValue(String(Number((saved / 1_000_000).toFixed(2))));
  }, [saved]);
  if (!wiki.value) {
    return wiki.error
      ? <span className="kb-inline-error kb-inline-error--flat" role="alert">Couldn’t read: {wiki.error}</span>
      : <span className="kb-muted" role="status">Reading…</span>;
  }
  const save = async () => {
    const millions = Number(value.trim().replace(',', '.'));
    if (!value.trim() || !Number.isFinite(millions) || millions < MIN_MILLIONS || millions > MAX_MILLIONS) {
      setError(`From ${MIN_MILLIONS} to ${MAX_MILLIONS} million characters.`);
      return;
    }
    const characters = Math.round(millions * 1_000_000);
    if (characters === saved) { setError(null); return; }
    const result = await settings.getState().updateWiki({ wiki_budget_characters: characters });
    setError(result.ok ? null : result.error ?? 'Couldn’t save.');
  };
  return (
    <>
      <span className={`kb-field__box kb-st-num${error ? ' has-error' : ''}`}>
        <input className="kb-field__input" type="number" inputMode="decimal" min={MIN_MILLIONS} max={MAX_MILLIONS}
          step={0.1} aria-label={`${label}, millions of characters`} value={value}
          onChange={(e) => setValue(e.target.value)} onBlur={() => void save()}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
      </span>
      {saved !== null && <span className="kb-muted">{`${charactersLabel(saved)} characters`}</span>}
      {error && <span className="kb-inline-error" role="alert">{error}</span>}
    </>
  );
}
