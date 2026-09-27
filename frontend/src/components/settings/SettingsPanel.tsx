import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useStore, type ThemeMode } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { ProfileEditor } from './ProfileEditor';
import { ProviderCredentials } from './ProviderCredentials';
import { LogsViewer } from './LogsViewer';
import { StorageRootPanel } from './StorageRootPanel';
import { CodexEnginePanel } from './CodexEnginePanel';
import { WebSearchSettings } from './WebSearchSettings';
import type { AgentModeToggle, CodexTab } from './ProfileEditor';
import { SonioxCredentials } from './SonioxCredentials';
import { UsedLanguages, languageName, byShownName } from './UsedLanguages';
import { CLOUD_PROVIDERS } from './providers';
import { useCodex } from '../../state/codex';
import { captureSourcesLocked } from '../../state/captureSources';
import { PURPOSE_KEYS, type CodexPurpose, type CodexSettings } from '../../api/codex';
import type { CloudProviderName, NativeRecordingMode, Profile, ProfileUpdate, ProviderName, SettingsUpdate, TaskKind } from '../../api/types';

interface SettingsPanelProps {
  onClose: () => void;
  initialSection?: SectionId;
}

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const TASKS: TaskKind[] = ['asr', 'agent', 'notes', 'embedding'];
const EMPTY_EMBEDDING: Profile = { provider: 'openrouter', model: '' };

export type SectionId = 'system' | 'asr' | 'agent' | 'notes' | 'embedding' | 'api-keys' | 'logs' | 'files' | 'web-search';

// Each model-assignment task is its own section so only ONE model catalog is
// ever mounted: all three at once put ~900 interactive rows in the DOM, which
// made hover and click in the picker unusable (measured, not guessed).
// Codex is not a section: it is the first provider tab of Assistant and Notes.
const SECTION_GROUPS: { label: string; sections: { id: SectionId; label: string; icon: IconName }[] }[] = [
  { label: 'Models', sections: [
    { id: 'asr', label: 'Transcription', icon: 'waveform' },
    { id: 'agent', label: 'Assistant', icon: 'robot' },
    { id: 'notes', label: 'Notes', icon: 'notes' },
    { id: 'embedding', label: 'Embedding', icon: 'nodes' },
  ] },
  { label: 'Access', sections: [
    { id: 'api-keys', label: 'API keys', icon: 'key' },
    { id: 'web-search', label: 'Web Search', icon: 'globe' },
  ] },
  { label: 'App', sections: [
    { id: 'system', label: 'System', icon: 'settings' },
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'logs', label: 'Logs', icon: 'terminal' },
  ] },
];

export function SettingsPanel({ onClose, initialSection = 'system' }: SettingsPanelProps) {
  const settings = useStore((s) => s.settings);
  const settingsError = useStore((s) => s.settingsError);
  const saveSettings = useStore((s) => s.saveSettings);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const devices = useStore((s) => s.devices);
  const selectedDeviceId = useStore((s) => s.selectedDeviceId);
  const enumerateDevices = useStore((s) => s.enumerateDevices);
  const selectDevice = useStore((s) => s.selectDevice);
  const setCaptureSystemAudio = useStore((s) => s.setCaptureSystemAudio);
  const recorderState = useStore((s) => s.recorderState);
  const [sourceError, setSourceError] = useState('');
  const codexAvailability = useCodex((s) => s.availability);
  const codexStored = useCodex((s) => s.settings);
  const agentView = useCodex((s) => s.agent);

  const capturing = ['recording', 'paused', 'processing'].includes(recorderState);
  // Sources change between recording stretches (before start, paused); they
  // apply at once, like the capsule's gear, and are not part of Save changes.
  const sourcesLocked = captureSourcesLocked(recorderState);
  const systemAudioSupported = window.skaz?.systemAudioSupported === true;
  const changeSource = (run: () => Promise<void>) => {
    setSourceError('');
    void run().catch((err: unknown) => setSourceError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    // Settings can open before the Assistant ever read the Codex boundary.
    const codex = useCodex.getState();
    if (codex.availability === 'unknown') void codex.load(codex.sessionId);
  }, []);

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
  const [embedding, setEmbedding] = useState<ProfileUpdate>({});
  const [limitEnabled, setLimitEnabled] = useState<boolean | undefined>();
  const [limitText, setLimitText] = useState<string | undefined>();
  const [usedLanguages, setUsedLanguages] = useState<string[] | null>(null);
  const [nativeMode, setNativeMode] = useState<NativeRecordingMode | null>(null);
  const [translationTarget, setTranslationTarget] = useState<string | null>(null);
  const [outputLanguage, setOutputLanguage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection);
  // One draft for both purposes: Assistant and Notes edit their own keys of the
  // same Codex document, so switching sections or signing in loses neither.
  const [codexDraft, setCodexDraft] = useState<Partial<CodexSettings>>({});

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
  const draftFor: Record<TaskKind, ProfileUpdate> = { asr, agent, notes, embedding };
  const profileFor: Record<TaskKind, Profile> = { asr: settings.asr, agent: settings.agent, notes: settings.notes, embedding: settings.embedding ?? EMPTY_EMBEDDING };

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

  const embeddingLimitEnabled = limitEnabled ?? (settings.embedding_budget_usd != null);
  const embeddingLimitText = limitText ?? String(settings.embedding_budget_usd ?? '');
  const embeddingLimit = Number(embeddingLimitText);
  const invalidLimit = embeddingLimitEnabled && (!embeddingLimitText.trim()
    || !Number.isFinite(embeddingLimit) || embeddingLimit <= 0 || embeddingLimit > 100);

  const codexSettings: CodexSettings | null = codexStored ? { ...codexStored, ...codexDraft } : null;
  const codexDirty = !!codexStored && (Object.keys(codexDraft) as (keyof CodexSettings)[])
    .some((key) => codexDraft[key] !== codexStored[key]);
  const changeCodex = (patch: Partial<CodexSettings>) => setCodexDraft((current) => ({ ...current, ...patch }));

  // Choosing a tab only records the choice; nothing is checked, started or called.
  const codexTab = (purpose: CodexPurpose): CodexTab => {
    const flag = PURPOSE_KEYS[purpose].enabled;
    return {
      selected: codexSettings?.[flag] === true,
      available: codexAvailability !== 'unavailable' && codexAvailability !== 'error',
      onSelect: () => changeCodex({ [flag]: true }),
      onDeselect: () => changeCodex({ [flag]: false }),
      panel: <CodexEnginePanel purpose={purpose} settings={codexSettings} disabled={saving} onChange={changeCodex} />,
    };
  };

  // Agent mode keeps the API profile and only changes how it reads the library.
  const agentMode = (purpose: CodexPurpose): AgentModeToggle | undefined => {
    if (!codexSettings || !agentView) return undefined;
    const flag = PURPOSE_KEYS[purpose].apiAgent;
    return {
      checked: codexSettings[flag] === true,
      disabled: saving,
      onChange: (checked) => changeCodex({ [flag]: checked }),
      status: agentView[purpose]?.api_agent ?? null,
    };
  };

  const buildUpdate = (): SettingsUpdate => {
    const update: SettingsUpdate = {};
    if (Object.keys(asr).length) update.asr = asr;
    if (Object.keys(agent).length) update.agent = agent;
    if (Object.keys(notes).length) update.notes = notes;
    if (Object.keys(embedding).length) update.embedding = embedding;
    if (limitEnabled !== undefined || limitText !== undefined) {
      update.embedding_budget_usd = embeddingLimitEnabled ? embeddingLimit : null;
    }
    if (usedLanguages !== null) update.used_languages = usedLanguages;
    if (nativeMode !== null) update.native_recording_mode = nativeMode;
    if (translationTarget !== null) update.translation_target_language = translationTarget;
    if (outputLanguage !== null) update.output_language = outputLanguage;

    if (Object.keys(providerKeys).length) update.provider_keys = providerKeys;
    if (cloudConsent !== null) update.cloud_consent = cloudConsent;
    return update;
  };

  const save = async () => {
    if (invalidLimit) return;
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
      setEmbedding({});
      setLimitEnabled(undefined);
      setLimitText(undefined);
      setUsedLanguages(null);
      setNativeMode(null);
      setTranslationTarget(null);
      setOutputLanguage(null);
      if (codexDirty) {
        // The API profiles above are already saved; a Codex failure keeps only its own draft.
        await useCodex.getState().saveSettings({ ...codexStored!, ...codexDraft });
      } else {
        // A new API model changes whether agent mode can run; re-read the verdict.
        void useCodex.getState().refreshAgent();
      }
      setCodexDraft({});
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
            {SECTION_GROUPS.map((group) => (
              <div key={group.label} className="settings-nav__group" role="group" aria-label={group.label}>
                <p className="settings-nav__heading" aria-hidden="true">{group.label}</p>
                {group.sections.map((section) => (
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
              </div>
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
                      value={selectedDeviceId && devices.some((d) => d.deviceId === selectedDeviceId) ? selectedDeviceId : ''}
                      onChange={(e) => changeSource(() => selectDevice(e.target.value))}
                      disabled={sourcesLocked}
                    >
                      {(devices.length === 0 || (selectedDeviceId !== null && !devices.some((d) => d.deviceId === selectedDeviceId)))
                        && <option value="">Default microphone</option>}
                      {devices.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `Microphone ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    <span className="field__hint">
                      {sourcesLocked ? 'Locked while recording.'
                        : selectedDeviceId !== null && devices.length > 0 && !devices.some((d) => d.deviceId === selectedDeviceId)
                          ? 'Saved microphone is not connected — recording uses the default one.'
                          : 'Applies immediately. Also available from the gear next to Record.'}
                    </span>
                  </div>
                  <div className="field field--row">
                    <div>
                      <label htmlFor="system-audio">Include system audio</label>
                      <p className="field__hint">
                        {systemAudioSupported
                          ? 'Records your computer’s sound too, such as the other side of a call. Use headphones to avoid echo.'
                          : 'System audio requires macOS 14.2 or later.'}
                      </p>
                    </div>
                    <input id="system-audio" type="checkbox" className="field__switch"
                      checked={settings.capture_system_audio === true && systemAudioSupported}
                      disabled={sourcesLocked || !systemAudioSupported}
                      onChange={(e) => changeSource(() => setCaptureSystemAudio(e.target.checked))} />
                  </div>
                  {sourceError && <p role="alert" className="field__error">{sourceError}</p>}
                </section>

                <section className="settings-group">
                  <div className="field field--row">
                    <div>
                      <label>Appearance</label>
                      <p className="field__hint">Applies immediately. Follows the system theme by default.</p>
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
                    <label htmlFor="native-recording-mode">New recording mode</label>
                    <select id="native-recording-mode" value={(nativeMode ?? settings.native_recording_mode) === 'audio_only' ? 'transcription' : (nativeMode ?? settings.native_recording_mode ?? 'transcription')}
                      disabled={saving || capturing}
                      onChange={(event) => setNativeMode(event.target.value as NativeRecordingMode)}>
                      <option value="transcription">Transcription</option>
                      <option value="translation">Transcription and translation</option>
                    </select>
                    <span className="field__hint">Applies to the next recording after saving. An existing recording keeps its mode.</span>
                  </div>
                  {(nativeMode ?? settings.native_recording_mode) === 'translation' && <div className="field">
                    <label htmlFor="translation-target">Translation language</label>
                    <select id="translation-target" value={translationTarget ?? settings.translation_target_language ?? 'ru'}
                      disabled={saving || capturing}
                      onChange={(event) => setTranslationTarget(event.target.value)}>
                      {byShownName([translationTarget ?? settings.translation_target_language ?? 'ru',
                        ...(settings.supported_languages ?? [])]).map((code) =>
                        <option key={code} value={code}>{languageName(code)}</option>)}
                    </select>
                    <span className="field__hint">
                      Speech in any of the selected languages is translated into this language. Soniox shows
                      the translation instead of the original; the original can be expanded under each turn.
                    </span>
                  </div>}
                  <p className="field__hint">The transcript and timestamps are saved. Audio is used for recognition and is not stored.</p>
                  <div className="field">
                    <label htmlFor="output-lang">Answer &amp; notes language</label>
                    <select
                      id="output-lang"
                      value={outputLanguage ?? settings.output_language}
                      disabled={saving}
                      onChange={(e) => setOutputLanguage(e.target.value)}
                    >
                      {byShownName([
                        outputLanguage ?? settings.output_language,
                        ...(settings.supported_languages ?? []),
                      ]).map((code) => (
                        <option key={code} value={code}>{languageName(code)}</option>
                      ))}
                    </select>
                    <span className="field__hint">
                      The language of assistant answers and notes. Independent of the spoken language —
                      you can listen in one language and get notes in another.
                    </span>
                  </div>
                </section>
              </section>
            )}

            {activeSection === 'web-search' && <WebSearchSettings />}

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
                    Live transcription runs through Soniox — model and endpoint choices here do not apply.
                    {settings.provider_has_api_key?.soniox === true
                      ? ' Key saved.'
                      : ' No key set — add it under API keys.'}
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
                  codex={codexTab('assistant')}
                  agentMode={agentMode('assistant')}
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
                  codex={codexTab('notes')}
                  agentMode={agentMode('notes')}
                />
              </section>
            )}

            {activeSection === 'embedding' && (
              <section className="settings-section">
                <h3 className="settings-section__title">Embedding</h3>
                <ProfileEditor
                  task="embedding"
                  label="Embedding"
                  description="Creates vectors for semantic search in original transcripts."
                  profile={profileFor.embedding}
                  draft={embedding}
                  hasProviderKey={providerHasKey(effectiveProvider('embedding'))}
                  onChange={setEmbedding}
                />
                <label className="consent">
                  <input type="checkbox" checked={embeddingLimitEnabled} disabled={saving}
                    onChange={(event) => setLimitEnabled(event.target.checked)} />
                  <span>Limit embedding cost per question</span>
                </label>
                {embeddingLimitEnabled && <div className="field">
                  <label htmlFor="embedding-limit">Embedding limit, USD</label>
                  <input id="embedding-limit" type="number" min="0" max="100" step="any"
                    value={embeddingLimitText} disabled={saving}
                    onChange={(event) => setLimitText(event.target.value)} />
                  {invalidLimit && <span className="field__hint">Enter an amount greater than 0 and no more than 100 USD.</span>}
                </div>}
                <p className="field__hint">
                  Optional, off by default. Applies to new text vectors and the query per question,
                  not a monthly budget. Assistant generation is billed separately.
                  When disabled, no embedding cost limit is applied. Save changes to apply.
                </p>
                <p className="field__hint">
                  Uses the shared OpenRouter key. Only zero-retention, no-training routes may be used.
                  Saving does not start indexing. Semantic search sends new original speech and your query
                  from the selected search scope when you ask a question. Provider charges apply; cloud consent is required.
                </p>
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
                      Disabling this stops live transcription and recording after Save.
                      Saved transcripts and notes are kept; there is no stored audio to upload later.
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
          <Button variant="primary" onClick={() => void save()} disabled={activeSection === 'files' || saving || invalidLimit || usedLanguages?.length === 0}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
