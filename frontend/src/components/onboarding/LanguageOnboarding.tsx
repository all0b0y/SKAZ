import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { languageName } from '../settings/UsedLanguages';

// First-run language gate.
//
// Without used_languages the recorder refuses to start (store.ts guards it), so
// a fresh install used to fail at the moment of recording with a message
// pointing at Settings. This modal asks the question up front instead. It is
// deliberately not dismissable: any exit path would lead back to that failure.

const QUICK_PICKS: { label: string; codes: string[] }[] = [
  { label: 'Русский', codes: ['ru'] },
  { label: 'English', codes: ['en'] },
  { label: 'Русский + English', codes: ['ru', 'en'] },
];

export function LanguageOnboarding() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);

  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = settings?.supported_languages ?? [];
  // Sorted by the name actually shown, not by ISO code: a list that reads
  // "Африкаанс, Албанский, Баскский" looks unsorted to the person reading it.
  const sorted = useMemo(
    () => [...supported].sort((a, b) => languageName(a).localeCompare(languageName(b), 'ru')),
    [supported],
  );
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru');
    if (!needle) return sorted;
    return sorted.filter(
      (code) => languageName(code).toLocaleLowerCase('ru').includes(needle) || code.includes(needle),
    );
  }, [sorted, query]);

  const samePick = (codes: string[]): boolean =>
    codes.length === selected.length && codes.every((code) => selected.includes(code));

  const toggle = (code: string) => {
    setSelected((current) =>
      current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
    );
  };

  const confirm = async () => {
    if (!selected.length) return;
    setSaving(true);
    setError(null);
    try {
      await saveSettings({ used_languages: selected });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding__card">
        <h2 id="onboarding-title">На каких языках вы говорите?</h2>
        <p className="onboarding__lead">
          Выберите языки, которые будут звучать в ваших записях. Распознавание ограничится ими.
          Это можно изменить позже в настройках.
        </p>

        <div className="onboarding__quick">
          {QUICK_PICKS.map((pick) => (
            <button
              key={pick.label}
              type="button"
              className={
                samePick(pick.codes) ? 'onboarding__quick-btn onboarding__quick-btn--on' : 'onboarding__quick-btn'
              }
              aria-pressed={samePick(pick.codes)}
              onClick={() => setSelected(pick.codes)}
            >
              {pick.label}
            </button>
          ))}
        </div>

        <input
          type="search"
          className="onboarding__search"
          placeholder="Поиск языка"
          aria-label="Поиск языка"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="onboarding__list" role="group" aria-label="Используемые языки">
          {matches.length === 0 ? (
            <p className="profile__note">Ничего не найдено.</p>
          ) : (
            matches.map((code) => (
              <label key={code} className="onboarding__option">
                <input
                  type="checkbox"
                  checked={selected.includes(code)}
                  disabled={saving}
                  onChange={() => toggle(code)}
                />
                {languageName(code)}
              </label>
            ))
          )}
        </div>

        {error && <p className="profile__note profile__note--warn">{error}</p>}

        <footer className="onboarding__foot">
          <span className="field__hint">
            {selected.length ? `Выбрано: ${selected.map(languageName).join(', ')}` : 'Выберите хотя бы один язык.'}
          </span>
          <Button variant="primary" onClick={() => void confirm()} disabled={saving || selected.length === 0}>
            {saving ? 'Сохранение…' : 'Продолжить'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
