import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from './SettingsPanel';
import { parseAliases, proactiveUpdate } from './ProactiveSettings';
import { useStore } from '../../state/store';
import type { Settings, SettingsUpdate } from '../../api/types';

const settings = (over: Partial<Settings> = {}): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' },
  agent: { provider: 'openrouter', model: 'qwen/fixture' },
  notes: { provider: 'openrouter', model: 'notes' },
  transcript_language: 'auto',
  output_language: 'ru',
  cloud_consent: true,
  contextual_local_enabled: false,
  proactive: { enabled: false, aliases: [], sound: false, model_consent: false },
  ...over,
});

let saveSettings: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saveSettings = vi.fn(async (_update: SettingsUpdate) => undefined);
  useStore.setState({
    settings: settings(),
    settingsError: null,
    saveSettings: saveSettings as unknown as (update: SettingsUpdate) => Promise<void>,
    recorderState: 'idle',
    devices: [],
    selectedDeviceId: null,
    enumerateDevices: vi.fn(async () => undefined),
  });
});

async function open() {
  const user = userEvent.setup();
  render(<SettingsPanel onClose={() => {}} initialSection="proactive" />);
  return user;
}

describe('Proactive assistant settings', () => {
  it('is off by default with sound off', async () => {
    await open();
    expect(screen.getByRole('checkbox', { name: /Enable the proactive assistant/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Sound/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Send transcript text/ })).not.toBeChecked();
  });

  it('cannot be enabled without names and model consent', async () => {
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: /Enable the proactive assistant/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add at least one name');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.type(screen.getByLabelText('Your names, nicknames and code phrases'), 'Alex{enter}Саша');
    expect(screen.getByRole('alert')).toHaveTextContent('Allow sending transcript text');
    await user.click(screen.getByRole('checkbox', { name: /Send transcript text/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(saveSettings).toHaveBeenCalledWith({
      proactive: { enabled: true, aliases: ['Alex', 'Саша'], model_consent: true },
    });
  });

  it('withdrawing model consent also turns the assistant off', async () => {
    useStore.setState({ settings: settings({ proactive: {
      enabled: true, aliases: ['Alex'], sound: false, model_consent: true,
    } }) });
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: /Send transcript text/ }));
    expect(screen.getByRole('checkbox', { name: /Enable the proactive assistant/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(saveSettings).toHaveBeenCalledWith({ proactive: { enabled: false, model_consent: false } });
  });

  it('names the model the text is sent to', async () => {
    await open();
    expect(screen.getByText(/qwen\/fixture/)).toBeInTheDocument();
  });
});

describe('alias parsing', () => {
  it('trims, splits on lines and commas, and de-duplicates', () => {
    expect(parseAliases(' Alex \nalex, Саша\n\n  project   falcon ')).toEqual(['Alex', 'Саша', 'project falcon']);
  });

  it('sends only changed fields', () => {
    const stored = { enabled: true, aliases: ['Alex'], sound: false, model_consent: true };
    expect(proactiveUpdate(stored, {})).toBeNull();
    expect(proactiveUpdate(stored, { sound: true })).toEqual({ sound: true });
  });
});
