import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from './SettingsPanel';
import { useStore } from '../../state/store';
import type { Settings, SettingsUpdate } from '../../api/types';

// Transcription is fixed to Soniox and the experimental contextual-local
// controls are gone, so these tests pin what the drawer still offers: a
// Soniox statement with no model picker, a language picker for answers and
// notes, and a Logs section in place of Local models.

const settings = (over: Partial<Settings> = {}): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' },
  agent: { provider: 'openrouter', model: 'agent' },
  notes: { provider: 'openrouter', model: 'notes' },
  transcript_language: 'auto',
  output_language: 'ru',
  cloud_consent: false,
  contextual_local_enabled: false,
  ...over,
});

let saveSettings: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saveSettings = vi.fn(async (_update: SettingsUpdate) => undefined);
  useStore.setState({
    settings: settings(),
    settingsError: null,
    saveSettings: saveSettings as unknown as (update: SettingsUpdate) => Promise<void>,
    loadModels: vi.fn(async () => []),
    localModelStatus: vi.fn(async () => ({ model: 'small', state: 'not_installed' as const })),
    recorderState: 'idle',
    devices: [],
    selectedDeviceId: null,
    // SettingsPanel enumerates devices on mount; stub it so unrelated async
    // store updates don't fire outside act() during these UI unit tests.
    enumerateDevices: vi.fn(async () => undefined),
    selectDevice: vi.fn(),
    nextRecordingMode: 'legacy',
    setNextRecordingMode: vi.fn((mode) => useStore.setState({ nextRecordingMode: mode })),
    liveCapabilities: null,
  });
});

/** Sections are tabbed now; switch to the one a test needs before querying it. */
const goToSection = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole('button', { name: label }));
};


describe('SettingsPanel transcription provider (fixed to Soniox)', () => {
  it('states Soniox without offering a model or base_url to pick', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'Transcription');

    expect(screen.getByText('Transcription (ASR)')).toBeInTheDocument();
    expect(screen.getByText('Soniox')).toBeInTheDocument();

    // ASR has no picker at all, and no other task's catalog is mounted here.
    expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
  });

  // One catalog per section: mounting all three at once put ~900 rows in the
  // DOM and made the picker unusable, so each task owns its own section.
  it('mounts exactly one model catalog per section', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);

    await goToSection(user, 'Assistant');
    await waitFor(() => {
      expect(screen.getAllByRole('listbox', { name: 'Model' })).toHaveLength(1);
    });

    await goToSection(user, 'Notes');
    await waitFor(() => {
      expect(screen.getAllByRole('listbox', { name: 'Model' })).toHaveLength(1);
    });
  });

  it('points at API keys when no Soniox key is stored yet', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'Transcription');
    expect(screen.getByText(/Ключ не задан/i)).toBeInTheDocument();
  });

  it('reports a stored Soniox key instead of asking for one', async () => {
    useStore.setState({ settings: settings({ provider_has_api_key: { soniox: true } }) });
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'Transcription');
    expect(screen.getByText(/Ключ сохранён/i)).toBeInTheDocument();
  });

  it('never sends an asr profile change, because there is nothing to change', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(saveSettings.mock.calls[0]![0]).not.toHaveProperty('asr');
  });
});

describe('SettingsPanel removed experimental controls', () => {
  it('no longer offers the contextual local opt-in', () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.queryByRole('checkbox', { name: /experimental contextual local mode/i })).toBeNull();
  });

  it('no longer offers a per-recording transcription mode picker', () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.queryByRole('combobox', { name: /transcription mode for new recording/i })).toBeNull();
  });

  it('never sends contextual_local_enabled on save', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(saveSettings.mock.calls[0]![0]).not.toHaveProperty('contextual_local_enabled');
  });
});

describe('SettingsPanel answer & notes language', () => {
  it('is a picker over supported languages, not a free-text field', async () => {
    useStore.setState({ settings: settings({ supported_languages: ['ru', 'en', 'de'] }) });
    render(<SettingsPanel onClose={() => {}} />);

    const select = screen.getByLabelText(/Answer & notes language/i);
    expect(select.tagName).toBe('SELECT');
    expect(screen.getByRole('option', { name: 'Немецкий' })).toBeInTheDocument();
  });

  it('sends the chosen language on save', async () => {
    useStore.setState({ settings: settings({ supported_languages: ['ru', 'en', 'de'] }) });
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);

    await user.selectOptions(screen.getByLabelText(/Answer & notes language/i), 'de');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(saveSettings).toHaveBeenCalledWith({ output_language: 'de' });
  });

  it('keeps a persisted value that is no longer in the supported list', () => {
    useStore.setState({ settings: settings({ output_language: 'eo', supported_languages: ['ru', 'en'] }) });
    render(<SettingsPanel onClose={() => {}} />);
    expect((screen.getByLabelText(/Answer & notes language/i) as HTMLSelectElement).value).toBe('eo');
  });
});

describe('SettingsPanel sections', () => {
  it('offers Logs and no longer offers Local models', () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Local models' })).toBeNull();
  });
});

describe('SettingsPanel device picker (moved from the recorder bar)', () => {
  it('lists enumerated microphones and forwards a selection', async () => {
    const selectDevice = vi.fn();
    useStore.setState({
      devices: [
        { deviceId: 'mic-1', label: 'Built-in Microphone' } as MediaDeviceInfo,
        { deviceId: 'mic-2', label: 'USB Mic' } as MediaDeviceInfo,
      ],
      selectedDeviceId: 'mic-1',
      selectDevice,
    });
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);

    const select = screen.getByLabelText('Microphone');
    expect(select).not.toBeDisabled();
    await user.selectOptions(select, 'mic-2');
    expect(selectDevice).toHaveBeenCalledWith('mic-2');
  });

  it('locks the device picker while a recording is in progress', () => {
    useStore.setState({ recorderState: 'recording' });
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByLabelText('Microphone')).toBeDisabled();
    expect(screen.getByText(/Locked while recording/i)).toBeInTheDocument();
  });
});

describe('SettingsPanel API keys section', () => {
  it('lists every cloud provider, assigned or not, and no local one', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'API keys');
    // A key belongs to the provider, so it can be stored before any assignment.
    expect(screen.getByRole('heading', { name: 'openrouter' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'openai' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'anthropic' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'local-whisper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'local-gigachat-mlx' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'openai-compatible' })).not.toBeInTheDocument();
  });

  it('saves a key under its provider, not copied into each task profile', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'API keys');

    // agent and notes both use openrouter, yet the credential is written once.
    const [openrouterKey] = screen.getAllByLabelText('API key');
    await user.type(openrouterKey!, 'sk-test');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(saveSettings).toHaveBeenCalledWith({ provider_keys: { openrouter: 'sk-test' } });
  });

  it('stores a key for a provider no task uses yet', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'API keys');

    // Default assignment is local-whisper + openrouter; anthropic is unassigned.
    const anthropicCard = screen.getByRole('heading', { name: 'anthropic' }).closest('section');
    const anthropicKey = within(anthropicCard as HTMLElement).getByLabelText('API key');
    await user.type(anthropicKey, 'ant-test');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // No task was reassigned just to hold the credential.
    expect(saveSettings).toHaveBeenCalledWith({ provider_keys: { anthropic: 'ant-test' } });
  });

  it('shows one key field per cloud provider and none for local ones', async () => {
    useStore.setState({
      settings: settings({
        asr: { provider: 'local-whisper', model: 'small' },
        agent: { provider: 'local-whisper', model: 'small' },
        notes: { provider: 'local-whisper', model: 'small' },
      }),
    });
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'API keys');
    expect(screen.getAllByLabelText('API key')).toHaveLength(3);
    expect(screen.getAllByText(/not assigned to any task yet/i)).toHaveLength(3);
  });
});

describe('SettingsPanel wordmark', () => {
  it('shows a quiet SKAZ wordmark below all sections', () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByText('SKAZ')).toBeInTheDocument();
  });
});
