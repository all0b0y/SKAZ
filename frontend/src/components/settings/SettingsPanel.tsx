import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useStore, type ThemeMode } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { ProfileEditor } from './ProfileEditor';
import { ProviderCredentials } from './ProviderCredentials';
import { LogsViewer } from './LogsViewer';
import { StorageRootPanel } from './StorageRootPanel';
import { SonioxCredentials } from './SonioxCredentials';
import { UsedLanguages, languageName } from './UsedLanguages';
import { CLOUD_PROVIDERS } from './providers';
import type { CloudProviderName, NativeRecordingMode, Profile, ProfileUpdate, ProviderName, SettingsUpdate, TaskKind } from '../../api/types';

interface SettingsPanelProps {
  onClose: () => void;
}

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const TASKS: TaskKind[] = ['asr', 'agent', 'notes'];

type SectionId = 'system' | 'asr' | 'agent' | 'notes' | 'api-keys' | 'logs' | 'files';

// Each model-assignment task is its own section so only ONE model catalog is
// ever mounted: all three at once put ~900 interactive rows in the DOM, which
// made hover and click in the picker unusable (measured, not guessed).
const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: 'system', label: 'System', icon: 'settings' },
  { id: 'asr', label: 'Transcription', icon: 'transcript' },
  { id: 'agent', label: 'Assistant', icon: 'notes' },
  { id: 'notes', label: 'Notes', icon: 'notes' },
  { id: 'api-keys', label: 'API keys', icon: 'sliders' },
  { id: 'logs', label: 'Logs', icon: 'transcript' },
  { id: 'files', label: 'Files', icon: 'transcript' },
];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const settings = useStore((s) => s.settings);
  const settingsError = useStore((s) => s.settingsError);
  const saveSettings = useStore((s) => s.saveSettings);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const devices = useStore((s) => s.devices);
  const selectedDeviceId = useStore((s) => s.selectedDeviceId);
  const enumerateDevices = useStore((s) => s.enumerateDevices);
  const selectDevice = useStore((s) => s.selectDevice);
  const recorderState = useStore((s) => s.recorderState);

  const capturing = ['recording', 'paused', 'processing'].includes(recorderState);

  useEffect(() => {
    void enumerateDevices();
    // Plugging in a headset or USB mic while Settings is open must update the
    // list; without this the user sees a stale set until the panel is reopened.
    const refresh = () => void enumerateDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, [enumerateDevices]);



  // Pending provider keys, keyed by provider: '' means "delete this key on save".
  const [providerKeys, setProviderKeys] = useState<Partial<Record<CloudProviderName, string>>>({});
  const [cloudConsent, setCloudConsent] = useState<boolean | null>(null);
  const [asr, setAsr] = useState<ProfileUpdate>({});
  const [agent, setAgent] = useState<ProfileUpdate>({});
  const [notes, setNotes] = useState<ProfileUpdate>({});
  const [usedLanguages, setUsedLanguages] = useState<string[] | null>(null);
  const [nativeMode, setNativeMode] = useState<NativeRecordingMode | null>(null);
  const [translationTarget, setTranslationTarget] = useState<string | null>(null);
  const [outputLanguage, setOutputLanguage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>('system');

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

  // API keys are provider-scoped, so the section lists every cloud provider
  // unconditionally. The per-task drafts below only carry provider/model.
  const draftFor: Record<TaskKind, ProfileUpdate> = { asr, agent, notes };
  const profileFor: Record<TaskKind, Profile> = { asr: settings.asr, agent: settings.agent, notes: settings.notes };

  const changeProviderKey = (provider: CloudProviderName, value: string) => {
    setProviderKeys((current) => ({ ...current, [provider]: value }));
  };
  // A key exists for a provider when one is stored, unless the current draft
  // clears it; a typed draft key counts as present before it is saved.
  const providerHasKey = (provider: ProviderName): boolean => {
    const pending = providerKeys[provider as CloudProviderName];
    if (pending !== undefined) return pending.trim().length > 0;
    return settings.provider_has_api_key?.[provider as CloudProviderName] === true;
  };

  const effectiveProvider = (task: TaskKind): ProviderName => draftFor[task].provider ?? profileFor[task].provider;
  const tasksForProvider = (provider: ProviderName): TaskKind[] => TASKS.filter((t) => effectiveProvider(t) === provider);

  const buildUpdate = (): SettingsUpdate => {
    const update: SettingsUpdate = {};
    if (Object.keys(asr).length) update.asr = asr;
    if (Object.keys(agent).length) update.agent = agent;
    if (Object.keys(notes).length) update.notes = notes;
    if (usedLanguages !== null) update.used_languages = usedLanguages;
    if (nativeMode !== null) update.native_recording_mode = nativeMode;
    if (translationTarget !== null) update.translation_target_language = translationTarget;
    if (outputLanguage !== null) update.output_language = outputLanguage;

    if (Object.keys(providerKeys).length) update.provider_keys = providerKeys;
    if (cloudConsent !== null) update.cloud_consent = cloudConsent;
    return update;
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await saveSettings(buildUpdate());

      setProviderKeys({});
      setCloudConsent(null);
      setAsr({});
      setAgent({});
      setNotes({});
      setUsedLanguages(null);
      setNativeMode(null);
      setTranslationTarget(null);
      setOutputLanguage(null);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Settings">
      <button className="drawer__scrim" aria-label="Close settings" onClick={onClose} />
      <div className="drawer__panel drawer__panel--settings">
        <header className="drawer__head">
          <h2>Settings</h2>
          <button className="drawer__close" onClick={onClose} aria-label="Close">
            <Icon name="chevron" />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={clsx('settings-nav__item', activeSection === section.id && 'settings-nav__item--active')}
                aria-current={activeSection === section.id}
                onClick={() => setActiveSection(section.id)}
              >
                <Icon name={section.icon} size={16} />
                {section.label}
              </button>
            ))}
            <p className="settings-logo">SKAZ</p>
          </nav>

          <div className="settings-content">
            {activeSection === 'system' && (
              <section className="settings-section">
                <h3 className="settings-section__title">System</h3>

                <section className="settings-group">
                  <div className="field">
                    <label htmlFor="mic-device">Microphone</label>
                    <select
                      id="mic-device"
                      value={selectedDeviceId ?? ''}
                      onChange={(e) => selectDevice(e.target.value)}
                      disabled={capturing}
                    >
                      {devices.length === 0 && <option value="">Default microphone</option>}
                      {devices.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `Microphone ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    <span className="field__hint">
                      {capturing ? 'Locked while recording.' : 'Used for the next recording session.'}
                    </span>
                  </div>
                </section>

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

                <section className="settings-group">
                  <div className="field">
                    <label>Interface language</label>
                    <p className="field__hint">English only for now. More languages are planned.</p>
                  </div>
                </section>

                <section className="settings-group">
                  <UsedLanguages supported={settings.supported_languages ?? []}
                    selected={usedLanguages ?? settings.used_languages ?? []}
                    onChange={setUsedLanguages} disabled={saving} />
                  <div className="field">
                    <label htmlFor="native-recording-mode">Режим новой записи</label>
                    <select id="native-recording-mode" value={(nativeMode ?? settings.native_recording_mode) === 'audio_only' ? 'transcription' : (nativeMode ?? settings.native_recording_mode ?? 'transcription')}
                      disabled={saving || capturing}
                      onChange={(event) => setNativeMode(event.target.value as NativeRecordingMode)}>
                      <option value="transcription">Транскрипция</option>
                      <option value="translation">Транскрипция и перевод</option>
                    </select>
                    <span className="field__hint">Применяется после сохранения к новой записи. Режим существующей записи не меняется.</span>
                  </div>
                  {(nativeMode ?? settings.native_recording_mode) === 'translation' && <div className="field">
                    <label htmlFor="translation-target">Язык перевода</label>
                    <select id="translation-target" value={translationTarget ?? settings.translation_target_language ?? 'ru'}
                      disabled={saving || capturing}
                      onChange={(event) => setTranslationTarget(event.target.value)}>
                      {Array.from(new Set([translationTarget ?? settings.translation_target_language ?? 'ru',
                        ...(settings.supported_languages ?? [])])).map((code) =>
                        <option key={code} value={code}>{languageName(code)}</option>)}
                    </select>
                    <span className="field__hint">
                      Речь на любом из выбранных языков переводится в этот язык. Soniox показывает
                      перевод вместо оригинала; оригинал можно раскрыть под репликой.
                    </span>
                  </div>}
                  <p className="field__hint">Сохраняются транскрипция и таймкоды. Аудио используется для распознавания и не сохраняется.</p>
                  <div className="field">
                    <label htmlFor="output-lang">Answer &amp; notes language</label>
                    <select
                      id="output-lang"
                      value={outputLanguage ?? settings.output_language}
                      disabled={saving}
                      onChange={(e) => setOutputLanguage(e.target.value)}
                    >
                      {Array.from(new Set([
                        outputLanguage ?? settings.output_language,
                        ...(settings.supported_languages ?? []),
                      ])).map((code) => (
                        <option key={code} value={code}>{languageName(code)}</option>
                      ))}
                    </select>
                    <span className="field__hint">
                      Язык ответов ассистента и конспектов. Не зависит от языка речи —
                      можно слушать на одном языке, а конспект получать на другом.
                    </span>
                  </div>
                </section>
              </section>
            )}

            {activeSection === 'asr' && (
              <section className="settings-section">
                <h3 className="settings-section__title">Transcription</h3>
                <div className="profile profile--fixed">
                  <div className="profile__head">
                    <div>
                      <strong>Transcription (ASR)</strong>
                      <p className="field__hint">Turns speech into timestamped text. Not a plain text model.</p>
                    </div>
                    <span className="profile__fixed-value">Soniox</span>
                  </div>
                  <p className="field__hint">
                    Живая транскрипция идёт через Soniox — выбор модели и адреса здесь не применяется.
                    {settings.provider_has_api_key?.soniox === true
                      ? ' Ключ сохранён.'
                      : ' Ключ не задан — добавьте его в разделе API keys.'}
                  </p>
                </div>
              </section>
            )}

            {activeSection === 'agent' && (
              <section className="settings-section">
                <h3 className="settings-section__title">Assistant</h3>
                <ProfileEditor
                  task="agent"
                  label="Assistant"
                  description="Answers your questions about the recording."
                  profile={settings.agent}
                  draft={agent}
                  hasProviderKey={providerHasKey(effectiveProvider('agent'))}
                  onChange={setAgent}
                />
              </section>
            )}

            {activeSection === 'notes' && (
              <section className="settings-section">
                <h3 className="settings-section__title">Notes</h3>
                <ProfileEditor
                  task="notes"
                  label="Notes"
                  description="Summarizes the session after you stop recording."
                  profile={settings.notes}
                  draft={notes}
                  hasProviderKey={providerHasKey(effectiveProvider('notes'))}
                  onChange={setNotes}
                />
              </section>
            )}

            {activeSection === 'api-keys' && (
              <section className="settings-section">
                <h3 className="settings-section__title">API keys</h3>
                <SonioxCredentials
                  hasKey={settings.provider_has_api_key?.soniox === true}
                  value={providerKeys.soniox ?? null}
                  onChange={(value) => changeProviderKey('soniox', value)}
                  disabled={saving}
                />
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={cloudConsent ?? settings.cloud_consent}
                    disabled={saving}
                    onChange={(e) => setCloudConsent(e.target.checked)}
                  />
                  <span>
                    <strong>Allow cloud processing</strong>
                    <span className="field__hint">
                      Sends audio to Soniox and requested text to configured cloud models; provider charges apply.
                      Saving with this disabled ends live transcription, not local audio recording.
                      Old recordings are never uploaded automatically.
                    </span>
                  </span>
                </label>
                <p className="settings-section__hint">
                  One key per provider, shared by every task assigned to it in Model assignment.
                  A key can be stored before the provider is assigned. Local providers need no key.
                </p>
                {CLOUD_PROVIDERS.map((provider) => (
                  <ProviderCredentials
                    key={provider}
                    provider={provider}
                    tasks={tasksForProvider(provider)}
                    hasStoredKey={settings.provider_has_api_key?.[provider] === true}
                    draftKey={providerKeys[provider]}
                    onChangeKey={changeProviderKey}
                  />
                ))}
              </section>
            )}

            {activeSection === 'files' && <StorageRootPanel capturing={capturing} />}

            {activeSection === 'logs' && (
              <section className="settings-section">
                <h3 className="settings-section__title">Logs</h3>
                <LogsViewer />
              </section>
            )}
          </div>
        </div>

        <footer className="drawer__foot">
          {saveError && <span className="profile__note profile__note--warn">{saveError}</span>}
          {saved && !saveError && <span className="profile__note profile__note--ok"><Icon name="check" size={13} /> Saved</span>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void save()} disabled={activeSection === 'files' || saving || usedLanguages?.length === 0}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
