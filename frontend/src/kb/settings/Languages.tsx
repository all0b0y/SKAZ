import { useId } from 'react';
import { Icon } from '../ui';
import { usePrefs, useServices } from '../state/context';

export const LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Russian' },
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
];

export const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

/** Languages the user hears: toggle chips (pressed = chosen). Saved in local prefs for now. */
export function LanguagePicker({ labelledBy }: { labelledBy?: string }) {
  const { prefs } = useServices();
  const chosen = usePrefs((s) => s.languages);
  const toggle = (code: string) => {
    const next = chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code];
    prefs.getState().set({ languages: next });
  };
  return (
    <div className="kb-tags" role="group" aria-labelledby={labelledBy}>
      {LANGUAGES.map((l) => {
        const on = chosen.includes(l.code);
        return (
          <button key={l.code} type="button" className={`kb-tag${on ? ' is-on' : ''}`} aria-pressed={on}
            onClick={() => toggle(l.code)}>
            {on && <Icon name="check" size={12} />}
            {l.name}
          </button>
        );
      })}
    </div>
  );
}

export function TranslationSelect({ label = 'Default translation', hideLabel = true }: { label?: string; hideLabel?: boolean }) {
  const id = useId();
  const { prefs } = useServices();
  const value = usePrefs((s) => s.translateTo);
  return (
    <span className="kb-select">
      <label htmlFor={id} className={hideLabel ? 'kb-visually-hidden' : 'kb-field__label'}>{label}</label>
      <select id={id} value={value} onChange={(e) => prefs.getState().set({ translateTo: e.target.value })}>
        <option value="">No translation</option>
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>into {l.name}</option>)}
      </select>
      <Icon name="chevronDown" size={12} className="kb-select__chev" />
    </span>
  );
}
