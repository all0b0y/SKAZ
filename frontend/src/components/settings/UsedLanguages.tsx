import './usedLanguages.css';

const names = new Intl.DisplayNames(['ru'], { type: 'language' });
export function languageName(code: string): string {
  const name = names.of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase('ru') + name.slice(1);
}

export function UsedLanguages({ supported, selected, onChange, disabled }: {
  supported: string[]; selected: string[]; onChange: (languages: string[]) => void; disabled: boolean;
}) {
  return <div className="field">
    <span id="used-languages-label">Используемые языки</span>
    <details className="used-languages">
      <summary aria-labelledby="used-languages-label used-languages-selection">
        <span id="used-languages-selection">{selected.length ? selected.map(languageName).join(', ') : 'Выбрать языки'}</span>
      </summary>
      <div className="used-languages__options" role="group" aria-label="Используемые языки">
        <button type="button" disabled={disabled || !supported.length} onClick={() => onChange([...supported])}>
          Выбрать все
        </button>
        {supported.map((code) => <label key={code}>
          <input type="checkbox" checked={selected.includes(code)} disabled={disabled}
            onChange={(event) => onChange(event.target.checked
              ? [...selected, code] : selected.filter((language) => language !== code))} />
          {languageName(code)}
        </label>)}
      </div>
    </details>
    <span className="field__hint">
      Выберите хотя бы один язык перед первой записью. Настройка применяется к новым записям.
      Soniox получает ограничение выбранными языками, но не гарантирует его строгое соблюдение.
    </span>
    {!supported.length && <span className="field__hint">Список языков недоступен. Откройте настройки повторно после подключения backend.</span>}
  </div>;
}
