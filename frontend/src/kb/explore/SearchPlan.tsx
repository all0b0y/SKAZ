import { useState } from 'react';
import type { KbSearchPlanItem } from '../../api/kb/types.gen';

export function SearchPlan({ items, message, failed, onRetry, onChange, disabled = false }: {
  items: KbSearchPlanItem[]; message: string | null; failed: boolean; onRetry: () => void;
  onChange: (items: KbSearchPlanItem[]) => void; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return <div className="kb-search-plan">
    <p className="kb-explore-cap" aria-live="polite">Will search: {items.length ? items.map((item) => item.terms.join(', ')).join(' · ') : '—'}</p>
    {message && <p className="kb-explore-cap" role={failed ? 'alert' : 'status'}>{message}{failed && <button type="button" className="kb-link" onClick={onRetry}>Try again</button>}</p>}
    {items.length > 0 && <button type="button" className="kb-explore-link" aria-expanded={editing} disabled={disabled} onClick={() => setEditing((v) => !v)}>
      {editing ? 'Done editing search plan' : 'Edit search plan'}
    </button>}
    {editing && <button type="button" className="kb-explore-link" disabled={disabled} onClick={onRetry}>Reset search plan</button>}
    {editing && items.length > 0 && <div className="kb-search-plan__items">
      {items.map((item, index) => <fieldset key={`${index}-${item.area_id}`} disabled={disabled} className="kb-search-plan__item">
        <legend>{item.label}</legend>
        {item.terms.map((term, termIndex) => <div key={termIndex} className="kb-search-plan__term">
          <input aria-label={`Search term ${termIndex + 1} for ${item.label}`} value={term} maxLength={72} className="kb-explore-search__input"
            onChange={(e) => onChange(items.map((old, n) => n === index ? { ...old, terms: old.terms.map((value, m) => m === termIndex ? e.target.value : value) } : old))} />
          <button type="button" className="kb-explore-icon-btn" aria-label={`Remove search term ${termIndex + 1} for ${item.label}`}
            onClick={() => onChange(items.map((old, n) => n === index ? { ...old, terms: old.terms.filter((_, m) => m !== termIndex) } : old))}>×</button>
        </div>)}
        <button type="button" className="kb-explore-link" aria-label={`Remove ${item.label} from search`} onClick={() => onChange(items.filter((_, n) => n !== index))}>Remove topic</button>
      </fieldset>)}
    </div>}
  </div>;
}
