import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { byShownName, languageName } from '../settings/UsedLanguages';
import { useModalFocus } from '../../hooks/useModalFocus';

const russianNames = new Intl.DisplayNames(['ru'], { type: 'language' });

/** Every name a person may type for a language: English (shown), the language's
 *  own name and Russian ("german", "deutsch", "немецкий"), plus the code. */
function searchNames(code: string): string[] {
  let own = '';
  try {
    own = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? '';
  } catch {
    // An unknown locale tag simply has no native name.
  }
  return [languageName(code), russianNames.of(code) ?? '', own, code].map((n) => n.toLocaleLowerCase());
}

// First-run language gate.
//
// Without used_languages the recorder refuses to start (store.ts guards it), so
// a fresh install used to fail at the moment of recording with a message
// pointing at Settings. This modal asks the question up front instead. It is
// deliberately not dismissable: any exit path would lead back to that failure.

const QUICK_PICKS: { label: string; codes: string[] }[] = [
  { label: 'Russian', codes: ['ru'] },
  { label: 'English', codes: ['en'] },
  { label: 'Russian + English', codes: ['ru', 'en'] },
];

export function LanguageOnboarding() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);

  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef);

  const supported = settings?.supported_languages ?? [];
  // Sorted by the name actually shown, not by ISO code: a list that reads
  // "Африкаанс, Албанский, Баскский" looks unsorted to the person reading it.
  const sorted = useMemo(() => byShownName(supported), [supported]);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return sorted;
    return sorted.filter((code) => searchNames(code).some((name) => name.includes(needle)));
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
    <div ref={dialogRef} className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabIndex={-1}>
      <div className="onboarding__card">
        <h2 id="onboarding-title">Which languages do you speak?</h2>
        <p className="onboarding__lead">
          Choose the languages spoken in your recordings. Recognition is limited to them.
          You can change this later in Settings.
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
          placeholder="Search languages"
          aria-label="Search languages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="onboarding__list" role="group" aria-label="Languages in use">
          {matches.length === 0 ? (
            <p className="profile__note">Nothing found.</p>
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
            {selected.length ? `Selected: ${selected.map(languageName).join(', ')}` : 'Choose at least one language.'}
          </span>
          <Button variant="primary" onClick={() => void confirm()} disabled={saving || selected.length === 0}>
            {saving ? 'Saving…' : 'Continue'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
