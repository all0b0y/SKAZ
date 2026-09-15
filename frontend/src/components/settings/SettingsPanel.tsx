import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useStore, type ThemeMode } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { ProfileEditor } from './ProfileEditor';
import { ProviderCredentials } from './ProviderCredentials';
import { LocalModelsBrowser } from './LocalModelsBrowser';
import { SonioxCredentials } from './SonioxCredentials';
import { UsedLanguages, languageName } from './UsedLanguages';
import type { NativeRecordingMode, Profile, ProfileUpdate, ProviderName, SettingsUpdate, TaskKind } from '../../api/types';

interface SettingsPanelProps {
  onClose: () => void;
}

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const TASKS: TaskKind[] = ['asr', 'agent', 'notes'];

type SectionId = 'system' | 'models' | 'api-keys' | 'local-models';

const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: 'system', label: 'System', icon: 'settings' },
  { id: 'models', label: 'Model assignment', icon: 'notes' },
  { id: 'api-keys', label: 'API keys', icon: 'sliders' },
  { id: 'local-models', label: 'Local models', icon: 'transcript' },
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
  const recordingMode = useStore((s) => s.nextRecordingMode);
  const setNextRecordingMode = useStore((s) => s.setNextRecordingMode);
  const liveCapabilities = useStore((s) => s.liveCapabilities);

  const capturing = ['recording', 'paused', 'processing'].includes(recorderState);

  useEffect(() => {
    void enumerateDevices();
  }, [enumerateDevices]);


  const [sonioxKey, setSonioxKey] = useState<string | null>(null);
  const [cloudConsent, setCloudConsent] = useState<boolean | null>(null);
  const [asr, setAsr] = useState<ProfileUpdate>({});
  const [agent, setAgent] = useState<ProfileUpdate>({});
  const [notes, setNotes] = useState<ProfileUpdate>({});
  const [usedLanguages, setUsedLanguages] = useState<string[] | null>(null);
  const [nativeMode, setNativeMode] = useState<NativeRecordingMode | null>(null);
  const [translationTarget, setTranslationTarget] = useState<string | null>(null);
  const [outputLanguage, setOutputLanguage] = useState<string | null>(null);
  // null means "untouched": an unopened or merely inspected drawer never sends
  // the experimental opt-in, so the mode can only be enabled deliberately.
  const [contextualLocal, setContextualLocal] = useState<boolean | null>(null);
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

  // Providers section: fold the three per-task profiles down to "which
  // provider does each task effectively use right now" (draft-aware), so a
  // key typed once can be copied into every profile that shares a provider.
  // The backend contract is unchanged — buildUpdate still sends three profiles.
  const draftFor: Record<TaskKind, ProfileUpdate> = { asr, agent, notes };
  const setDraftFor: Record<TaskKind, (update: ProfileUpdate) => void> = {
    asr: setAsr,
    agent: setAgent,
    notes: setNotes,
  };
  const profileFor: Record<TaskKind, Profile> = { asr: settings.asr, agent: settings.agent, notes: settings.notes };

  const patchDraft = (task: TaskKind, patch: Partial<ProfileUpdate>) => {
    setDraftFor[task]({ ...draftFor[task], ...patch });
  };
  const applyKeyToTasks = (tasks: TaskKind[], value: string) => {
    tasks.forEach((task) => patchDraft(task, { api_key: value }));
  };
  const applyBaseUrlToTasks = (tasks: TaskKind[], value: string) => {
    tasks.forEach((task) => patchDraft(task, { base_url: value }));
  };

  const effectiveProvider = (task: TaskKind): ProviderName => draftFor[task].provider ?? profileFor[task].provider;
  const usedProviders: ProviderName[] = [];
  TASKS.forEach((task) => {
    const provider = effectiveProvider(task);
    if (!usedProviders.includes(provider)) usedProviders.push(provider);
  });
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
    if (sonioxKey !== null) update.soniox_api_key = sonioxKey;
    if (cloudConsent !== null) update.cloud_consent = cloudConsent;
    if (contextualLocal !== null) update.contextual_local_enabled = contextualLocal;
    return update;
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await saveSettings(buildUpdate());
      setSonioxKey(null);
      setCloudConsent(null);
      setAsr({});
      setAgent({});
      setNotes({});
      setUsedLanguages(null);
      setNativeMode(null);
      setTranslationTarget(null);
      setOutputLanguage(null);
      setContextualLocal(null);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const contextualLocalValue = contextualLocal ?? settings.contextual_local_enabled;
  const asrProvider = asr.provider ?? settings.asr.provider;

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
                    <select id="native-recording-mode" value={nativeMode ?? settings.native_recording_mode ?? 'transcription'}
                      disabled={saving || capturing}
                      onChange={(event) => setNativeMode(event.target.value as NativeRecordingMode)}>
                      <option value="transcription">Транскрипция</option>
                      <option value="translation">Транскрипция и перевод</option>
                      <option value="audio_only">Только аудио</option>
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
                    <span className="field__hint">Soniox показывает перевод вместо оригинала. Оригинал можно раскрыть под репликой.</span>
                  </div>}
                  {(nativeMode ?? settings.native_recording_mode) === 'audio_only' &&
                    <p className="field__hint">Сохраняется только аудио. Распознавание после записи пока не подключено.</p>}
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
                      checked={contextualLocalValue}
                      onChange={(e) => setContextualLocal(e.target.checked)}
                    />
                    <span>
                      <strong>Experimental contextual local mode</strong>
                      <span className="field__hint">
                        Turns on local live finality and the local speech gate for new contextual
                        recordings with a local-whisper profile. Off by default; it changes nothing
                        for legacy or cloud recordings, and it is not a quality claim.
                      </span>
                    </span>
                  </label>
                  {contextualLocalValue && asrProvider !== 'local-whisper' && (
                    <p className="profile__note profile__note--warn">
                      Contextual local recording also needs a local-whisper transcription profile;
                      the current ASR profile is “{asrProvider}”.
                    </p>
                  )}
                  <div className="field">
                    <label htmlFor="recording-mode">Transcription mode for the next recording</label>
                    <select
                      id="recording-mode"
                      aria-label="Transcription mode for new recording"
                      value={recordingMode}
                      onChange={(event) => setNextRecordingMode(event.currentTarget.value as 'legacy' | 'contextual_local')}
                      disabled={capturing}
                    >
                      <option value="legacy">Legacy / cloud-compatible</option>
                      <option value="contextual_local">Experimental contextual local</option>
                    </select>
                    {!capturing && recordingMode === 'contextual_local' && (
                      <p className={liveCapabilities?.capable ? 'profile__note' : 'profile__note profile__note--warn'}>
                        {liveCapabilities?.detail ?? 'Checking contextual local capability…'} This choice applies only to a new recording session.
                      </p>
                    )}
                  </div>
                </section>
              </section>
            )}

            {activeSection === 'models' && (
              <section className="settings-section">
                <h3 className="settings-section__title">Model assignment</h3>
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
              </section>
            )}

            {activeSection === 'api-keys' && (
              <section className="settings-section">
                <h3 className="settings-section__title">API keys</h3>
                <SonioxCredentials
                  hasKey={settings.soniox_has_api_key === true}
                  value={sonioxKey}
                  onChange={setSonioxKey}
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
                  One key per provider, applied to every task assigned to it in Model assignment.
                  Local providers need no key and are not listed here.
                </p>
                {usedProviders.filter((p) => p !== 'local-whisper' && p !== 'local-gigachat-mlx').length === 0 ? (
                  <p className="profile__note">
                    No cloud providers are assigned yet. Pick one in Model assignment to add its key here.
                  </p>
                ) : (
                  usedProviders
                    .filter((p) => p !== 'local-whisper' && p !== 'local-gigachat-mlx')
                    .map((provider) => (
                      <ProviderCredentials
                        key={provider}
                        provider={provider}
                        tasks={tasksForProvider(provider)}
                        profiles={profileFor}
                        drafts={draftFor}
                        onApplyKey={applyKeyToTasks}
                        onChangeBaseUrl={applyBaseUrlToTasks}
                      />
                    ))
                )}
              </section>
            )}

            {activeSection === 'local-models' && (
              <section className="settings-section">
                <h3 className="settings-section__title">Local models</h3>
                <LocalModelsBrowser />
              </section>
            )}
          </div>
        </div>

        <footer className="drawer__foot">
          {saveError && <span className="profile__note profile__note--warn">{saveError}</span>}
          {saved && !saveError && <span className="profile__note profile__note--ok"><Icon name="check" size={13} /> Saved</span>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || usedLanguages?.length === 0}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
