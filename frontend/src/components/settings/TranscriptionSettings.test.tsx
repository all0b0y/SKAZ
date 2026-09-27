import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from './SettingsPanel';
import { useStore } from '../../state/store';
import type { LocalModelProviderName, LocalModelStatus, Settings, SettingsUpdate, TranscriptionProviderInfo } from '../../api/types';

const capabilities = {
  soniox: {
    live: 'streaming', provisional_text: true, file_transcription: true, speakers: 'full', translation: 'any',
    language_detection: 'full', word_timestamps: 'exact', offline: false, requires_cloud_consent: true,
    api_key_provider: 'soniox',
  },
  'local-whisper': {
    live: 'near_streaming', provisional_text: true, file_transcription: true, speakers: 'approximate',
    translation: 'english_only', language_detection: 'selected_languages', word_timestamps: 'exact',
    offline: true, requires_cloud_consent: false,
  },
  openai: {
    live: 'utterance', provisional_text: false, file_transcription: true, speakers: 'approximate',
    translation: 'none', language_detection: 'full', word_timestamps: 'approximate', offline: false,
    requires_cloud_consent: true, api_key_provider: 'openai',
  },
} as const;

const providers: TranscriptionProviderInfo[] = [
  { id: 'soniox', label: 'Soniox', capabilities: capabilities.soniox, models: [], ready: true, limitations: [] },
  {
    id: 'local-whisper', label: 'Local Whisper', capabilities: capabilities['local-whisper'], ready: false,
    detail: "The Local Whisper model 'small' is not downloaded yet. Download it below.",
    model: 'small',
    models: [
      { id: 'tiny', name: 'Whisper tiny', size_bytes: 75_000_000 },
      { id: 'small', name: 'Whisper small', size_bytes: 484_000_000, recommended: true, note: 'Recommended for live use.' },
    ],
    limitations: ['Translation is available into English only.'],
  },
  {
    id: 'openai', label: 'OpenAI', capabilities: capabilities.openai, ready: false, detail: 'No OpenAI API key is stored.',
    model: 'whisper-1', models: [{ id: 'whisper-1', name: 'whisper-1' }], limitations: ['No live translation.'],
  },
];

const settings = (over: Partial<Settings> = {}): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' },
  agent: { provider: 'openrouter', model: 'agent' },
  notes: { provider: 'openrouter', model: 'notes' },
  transcript_language: 'auto',
  output_language: 'ru',
  cloud_consent: false,
  contextual_local_enabled: false,
  provider_has_api_key: { soniox: true },
  transcription_provider: 'soniox',
  local_whisper_model: 'small',
  openai_transcription_model: 'whisper-1',
  speaker_separation: true,
  transcription_providers: providers,
  ...over,
});

let saveSettings: ReturnType<typeof vi.fn>;
let prepareLocalModel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saveSettings = vi.fn(async (_update: SettingsUpdate) => undefined);
  prepareLocalModel = vi.fn(async (_provider: string, model: string): Promise<LocalModelStatus> => (
    { model, state: 'installing', progress: { stage: 'downloading', downloaded_bytes: 242_000_000, completed_files: 1 } }
  ));
  useStore.setState({
    settings: settings(),
    settingsError: null,
    saveSettings: saveSettings as unknown as (update: SettingsUpdate) => Promise<void>,
    refreshSettings: vi.fn(async () => undefined),
    loadModels: vi.fn(async () => []),
    localModelStatus: vi.fn(async (_provider, model) => ({ model, state: 'not_installed' as const })),
    prepareLocalModel: prepareLocalModel as unknown as (provider: LocalModelProviderName, model: string) => Promise<LocalModelStatus>,
    recorderState: 'idle',
    devices: [],
    selectedDeviceId: null,
    enumerateDevices: vi.fn(async () => undefined),
    selectDevice: vi.fn(async () => undefined),
    liveCapabilities: null,
  });
});

afterEach(() => vi.restoreAllMocks());

describe('Settings → Transcription provider choice', () => {
  it('lists every provider with its readiness and saves an explicit choice', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} initialSection="asr" />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual([
      expect.stringContaining('Soniox'), expect.stringContaining('Local Whisper'), expect.stringContaining('OpenAI'),
    ]);
    expect(screen.getByRole('radio', { name: /Soniox/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /OpenAI/ })).toHaveTextContent('No OpenAI API key is stored.');

    await user.click(screen.getByRole('radio', { name: /Local Whisper/ }));
    expect(screen.getByText(/works with the network off/)).toBeInTheDocument();
    expect(screen.getByText('Translation into English only')).toBeInTheDocument();
    expect(screen.getByText('Translation is available into English only.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Model'), 'tiny');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(saveSettings.mock.calls[0]![0]).toEqual({ transcription_provider: 'local-whisper', local_whisper_model: 'tiny' });
  });

  it('shows the download size and asks before downloading a local model', async () => {
    useStore.setState({ settings: settings({ transcription_provider: 'local-whisper' }) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} initialSection="asr" />);
    expect(screen.getByRole('option', { name: /Whisper small · 461.6 MiB · recommended/ })).toBeInTheDocument();
    const download = await screen.findByRole('button', { name: 'Download model (about 461.6 MiB)' });
    await user.click(download);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('about 461.6 MiB'));
    expect(prepareLocalModel).not.toHaveBeenCalled();
    await user.click(download);
    await waitFor(() => expect(prepareLocalModel).toHaveBeenCalledWith('local-whisper', 'small'));
    const progress = await screen.findByRole('progressbar', { name: 'Downloading small' });
    expect(Number(progress.getAttribute('value'))).toBeCloseTo(0.5, 1);
  });

  it('offers approximate speaker separation with its own local model', async () => {
    useStore.setState({ settings: settings({ transcription_provider: 'local-whisper' }) });
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} initialSection="asr" />);
    const toggle = screen.getByRole('checkbox', { name: /Separate speakers/ });
    expect(toggle).toBeChecked();
    expect(await screen.findByRole('button', { name: /Download model \(about 25\.4 MiB\)/ })).toBeInTheDocument();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(saveSettings.mock.calls[0]![0]).toEqual({ speaker_separation: false });
  });

  it('warns about the shared cache only once there are files to delete', async () => {
    const warning = 'This is the shared Hugging Face cache. Deleting this model may affect other applications.';
    useStore.setState({
      settings: settings({ transcription_provider: 'openai' }),
      localModelStatus: vi.fn(async (_provider, model) => ({ model, state: 'not_installed' as const, warning, cached: false })),
    });
    render(<SettingsPanel onClose={() => {}} initialSection="asr" />);
    expect(await screen.findByText('Not downloaded yet.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing extra is sent anywhere/)).toBeInTheDocument();
    expect(screen.queryByText(warning)).toBeNull();
  });
});
