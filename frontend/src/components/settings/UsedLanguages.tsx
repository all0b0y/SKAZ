import './usedLanguages.css';

// The interface is English-only for now, so language names are English too.
const names = new Intl.DisplayNames(['en'], { type: 'language' });
export function languageName(code: string): string {
  const name = names.of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase('en') + name.slice(1);
}

/** Languages in the order a reader expects: by the name shown, not ISO code. */
export function byShownName(codes: Iterable<string>): string[] {
  return [...new Set(codes)].sort((x, y) => languageName(x).localeCompare(languageName(y), 'en'));
}

export function UsedLanguages({ supported, selected, onChange, disabled }: {
  supported: string[]; selected: string[]; onChange: (languages: string[]) => void; disabled: boolean;
}) {
  return <div className="field">
    <span id="used-languages-label">Languages in use</span>
    <details className="used-languages">
      <summary aria-labelledby="used-languages-label used-languages-selection">
        <span id="used-languages-selection">{selected.length ? selected.map(languageName).join(', ') : 'Choose languages'}</span>
      </summary>
      <div className="used-languages__options" role="group" aria-label="Languages in use">
        <button type="button" disabled={disabled || !supported.length} onClick={() => onChange([...supported])}>
          Select all
        </button>
        {byShownName(supported).map((code) => <label key={code}>
          <input type="checkbox" checked={selected.includes(code)} disabled={disabled}
            onChange={(event) => onChange(event.target.checked
              ? [...selected, code] : selected.filter((language) => language !== code))} />
          {languageName(code)}
        </label>)}
      </div>
    </details>
    <span className="field__hint">
      Choose at least one language before the first recording. Applies to new recordings.
      Soniox is restricted to the selected languages but does not guarantee strict adherence.
    </span>
    {!supported.length && <span className="field__hint">The language list is unavailable. Reopen Settings once the backend is connected.</span>}
  </div>;
}
