import { useState } from 'react';
import { useStore, type ThemeMode } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ProfileEditor } from './ProfileEditor';
import type { ProfileUpdate, SettingsUpdate } from '../../api/types';

interface SettingsPanelProps {
  onClose: () => void;
}

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const settings = useStore((s) => s.settings);
  const settingsError = useStore((s) => s.settingsError);
  const saveSettings = useStore((s) => s.saveSettings);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  const [asr, setAsr] = useState<ProfileUpdate>({});
  const [agent, setAgent] = useState<ProfileUpdate>({});
  const [notes, setNotes] = useState<ProfileUpdate>({});
  const [transcriptLanguage, setTranscriptLanguage] = useState<string | null>(null);
  const [outputLanguage, setOutputLanguage] = useState<string | null>(null);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!settings) {
    return (
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="drawer__panel">
          <p className="loading">Loading settings…</p>
          {settingsError && <p className="profile__note profile__note--warn">{settingsError}</p>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  const buildUpdate = (): SettingsUpdate => {
    const update: SettingsUpdate = {};
    if (Object.keys(asr).length) update.asr = asr;
    if (Object.keys(agent).length) update.agent = agent;
    if (Object.keys(notes).length) update.notes = notes;
    if (transcriptLanguage !== null) update.transcript_language = transcriptLanguage;
    if (outputLanguage !== null) update.output_language = outputLanguage;
    if (consent !== null) update.cloud_consent = consent;
    return update;
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await saveSettings(buildUpdate());
      setAsr({});
      setAgent({});
      setNotes({});
      setTranscriptLanguage(null);
      setOutputLanguage(null);
      setConsent(null);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const consentValue = consent ?? settings.cloud_consent;

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Settings">
      <button className="drawer__scrim" aria-label="Close settings" onClick={onClose} />
      <div className="drawer__panel">
        <header className="drawer__head">
          <h2>Settings</h2>
          <button className="drawer__close" onClick={onClose} aria-label="Close">
            <Icon name="chevron" />
          </button>
        </header>

        <div className="drawer__body">
          <section className="settings-group">
            <div className="field field--row">
              <div>
                <label>Appearance</label>
                <p className="field__hint">Follows the system theme by default.</p>
              </div>
              <div className="segmented">
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    className={theme === t.value ? 'segmented__on' : ''}
                    onClick={() => setTheme(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <ProfileEditor
            task="asr"
            label="Transcription (ASR)"
            description="Turns speech into timestamped text. Not a plain text model."
            profile={settings.asr}
            draft={asr}
            onChange={setAsr}
          />
          <ProfileEditor
            task="agent"
            label="Assistant"
            description="Answers your questions about the recording."
            profile={settings.agent}
            draft={agent}
            onChange={setAgent}
          />
          <ProfileEditor
            task="notes"
            label="Notes"
            description="Summarizes the session after you stop recording."
            profile={settings.notes}
            draft={notes}
            onChange={setNotes}
          />

          <section className="settings-group">
            <div className="field">
              <label htmlFor="transcript-lang">Transcript language</label>
              <input
                id="transcript-lang"
                type="text"
                placeholder="auto"
                value={transcriptLanguage ?? settings.transcript_language}
                onChange={(e) => setTranscriptLanguage(e.target.value)}
              />
              <span className="field__hint">Use “auto” to detect. Recognition, not translation.</span>
            </div>
            <div className="field">
              <label htmlFor="output-lang">Answer &amp; notes language</label>
              <input
                id="output-lang"
                type="text"
                value={outputLanguage ?? settings.output_language}
                onChange={(e) => setOutputLanguage(e.target.value)}
              />
            </div>
          </section>

          <section className="settings-group">
            <label className="consent">
              <input
                type="checkbox"
                checked={consentValue}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                <strong>Allow sending audio and text to cloud providers</strong>
                <span className="field__hint">
                  Required for cloud ASR and cloud models. Local transcription never leaves your machine.
                </span>
              </span>
            </label>
          </section>
        </div>

        <footer className="drawer__foot">
          {saveError && <span className="profile__note profile__note--warn">{saveError}</span>}
          {saved && !saveError && <span className="profile__note profile__note--ok"><Icon name="check" size={13} /> Saved</span>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
