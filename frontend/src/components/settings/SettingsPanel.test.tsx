import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from './SettingsPanel';
import { useStore } from '../../state/store';
import type { Settings, SettingsUpdate } from '../../api/types';

// The experimental contextual local mode has no process-level switch a user can
// reach, so the settings drawer is the explicit opt-in seam: off by default,
// never sent unless the user touched it, and never enabled by merely opening it.

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

const toggle = () =>
  screen.getByRole('checkbox', { name: /experimental contextual local mode/i });

/** Sections are tabbed now; switch to the one a test needs before querying it. */
const goToSection = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole('button', { name: label }));
};


describe('SettingsPanel contextual local opt-in', () => {
  it('is off by default and is not sent when the user does not touch it', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);

    expect(toggle()).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0]![0]).not.toHaveProperty('contextual_local_enabled');
  });

  it('sends the explicit opt-in only after the user enables it', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);

    await user.click(toggle());
    expect(toggle()).toBeChecked();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(saveSettings).toHaveBeenCalledWith({
      contextual_local_enabled: true,
    });
  });

  it('reflects the persisted value and can turn the mode back off', async () => {
    useStore.setState({ settings: settings({ contextual_local_enabled: true, cloud_consent: true }) });
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);

    expect(toggle()).toBeChecked();

    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(saveSettings).toHaveBeenCalledWith({ contextual_local_enabled: false });
  });

  it('names what the opt-in turns on instead of promising quality', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'Model assignment');

    // Let all three async catalog effects settle inside Testing Library's act.
    await waitFor(() => {
      expect(screen.getAllByRole('listbox', { name: 'Model' })).toHaveLength(3);
    });

    await goToSection(user, 'System');
    const hint = screen.getByText(/local live finality and the local speech gate/i);
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent(/local-whisper/i);
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
  it('shows only cloud providers actually used by a task, not the full catalog', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'API keys');
    // asr -> local-whisper (no key needed, not listed), agent & notes -> openrouter.
    expect(screen.getByRole('heading', { name: 'openrouter' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'local-whisper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'openai' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'anthropic' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'local-gigachat-mlx' })).not.toBeInTheDocument();
  });

  it('collates one key entered once into every profile that shares that provider, on save', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'API keys');

    // agent and notes both use openrouter; asr uses the local provider and has no key field.
    await user.type(screen.getByLabelText('API key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(saveSettings).toHaveBeenCalledWith({
      agent: { api_key: 'sk-test' },
      notes: { api_key: 'sk-test' },
    });
  });

  it('never renders a key field for the local provider', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await goToSection(user, 'API keys');
    // Only one non-local provider (openrouter) is in play, so exactly one API key field exists.
    expect(screen.getAllByLabelText('API key')).toHaveLength(1);
  });

  it('shows nothing to configure when every assigned task uses a local provider', async () => {
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
    expect(screen.getByText(/no cloud providers are assigned yet/i)).toBeInTheDocument();
    expect(screen.queryAllByLabelText('API key')).toHaveLength(0);
  });
});

describe('SettingsPanel wordmark', () => {
  it('shows a quiet SKAZ wordmark below all sections', () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByText('SKAZ')).toBeInTheDocument();
  });
});

describe('SettingsPanel transcription mode picker (moved from the recorder bar)', () => {
  it('requires an explicit pre-recording contextual choice and clearly disables it without capability', async () => {
    const choose = vi.fn((mode) => useStore.setState({ nextRecordingMode: mode }));
    useStore.setState({
      setNextRecordingMode: choose,
      liveCapabilities: {
        mode: 'contextual_local', capable: false,
        requirements: { local_profile_selected: true, contextual_local_enabled: false, live_finality_enabled: false, local_speech_gate_enabled: false },
        detail: 'Enable both experimental flags.',
      },
    });
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await user.selectOptions(
      screen.getByRole('combobox', { name: /transcription mode for new recording/i }),
      'contextual_local',
    );
    expect(choose).toHaveBeenCalledWith('contextual_local');
    expect(screen.getByText(/Enable both experimental flags.*new recording session/i)).toBeInTheDocument();
  });

  it('locks the mode picker while a recording is in progress', () => {
    useStore.setState({ recorderState: 'recording' });
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByRole('combobox', { name: /transcription mode for new recording/i })).toBeDisabled();
  });
});
