interface SonioxCredentialsProps {
  hasKey: boolean;
  value: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
}

/** Dedicated native-ASR key; deliberately independent of legacy task profiles. */
export function SonioxCredentials({ hasKey, value, onChange, disabled }: SonioxCredentialsProps) {
  return (
    <section className="profile provider-card" aria-label="Soniox credentials">
      <header className="profile__head">
        <h4>Soniox</h4>
        <p>Live transcription. Audio is saved locally even when transcription is unavailable.</p>
      </header>
      <div className="field">
        <label htmlFor="soniox-api-key">Soniox API key</label>
        <input
          id="soniox-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={value ?? ''}
          placeholder={hasKey ? 'Key stored — enter a replacement' : 'Not set'}
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="profile__note" role="status">
          {value === '' ? 'Soniox key will be removed on Save.' : value !== null
            ? 'Soniox key replacement pending Save.' : hasKey
              ? 'Soniox key stored. Not verified by a real API request.'
              : 'No Soniox key stored. Recording remains local without transcription.'}
        </p>
        <p className="field__hint">
          Write-only secure backend storage. Saving a key does not grant cloud consent or run a paid check.
          Changes apply to the next connection; removing the key closes active transcription after Save.
        </p>
        <button
          type="button"
          className="profile__download"
          disabled={disabled || (!hasKey && value === null)}
          onClick={() => onChange('')}
        >
          Remove Soniox key
        </button>
      </div>
    </section>
  );
}
