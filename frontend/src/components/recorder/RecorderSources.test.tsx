import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecorderSources } from './RecorderSources';
import { useStore } from '../../state/store';
import type { Settings, SettingsUpdate } from '../../api/types';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';

const settings = (over: Partial<Settings> = {}): Settings => ({
  used_languages: ['en', 'ru'], supported_languages: ['en', 'ru', 'de'],
  asr: { provider: 'local-whisper', model: 'small' }, agent: { provider: 'openrouter', model: 'a' },
  notes: { provider: 'openrouter', model: 'n' }, transcript_language: 'auto', output_language: 'en',
  cloud_consent: true, contextual_local_enabled: false, native_recording_mode: 'transcription',
  translation_target_language: 'ru', input_device_id: null, capture_system_audio: false, ...over,
});

let saveSettings: ReturnType<typeof vi.fn>;
let pageMode: 'transcription' | 'translation' = 'translation';

beforeEach(() => {
  saveSettings = vi.fn(async (update: SettingsUpdate) => {
    useStore.setState((s) => ({ settings: { ...s.settings!, ...update } as Settings }));
  });
  window.skaz = { ...window.skaz, systemAudioSupported: true,
    request: vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
      if (req.path.endsWith('/live/events')) return { ok: true, status: 200, data: { recording_mode: pageMode, translation_target_language: 'de' } };
      return { ok: false, status: 404, detail: 'nope' };
    }) as never };
  useStore.setState({
    settings: settings(), saveSettings: saveSettings as never, recorderState: 'idle', settingsError: null,
    devices: [
      { deviceId: 'built-in', label: 'MacBook Pro Microphone', kind: 'audioinput' } as MediaDeviceInfo,
      { deviceId: 'usb', label: 'USB Mic', kind: 'audioinput' } as MediaDeviceInfo,
    ],
    selectedDeviceId: 'built-in', enumerateDevices: vi.fn(async () => undefined),
    activeSessionId: 's1',
  });
});

const show = (hasRecording = false) => render(<RecorderSources hasRecording={hasRecording} />);

describe('RecorderSources', () => {
  it('toggles system audio in one click and persists it', async () => {
    const user = userEvent.setup(); show();
    const toggle = screen.getByRole('button', { name: 'Include system audio' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(saveSettings).toHaveBeenCalledWith({ capture_system_audio: true });
    expect(screen.getByRole('button', { name: 'Include system audio' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('gear popover edits microphone, system audio, mode and language immediately', async () => {
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole('button', { name: 'Recording settings' }));
    const panel = screen.getByRole('dialog', { name: 'Recording settings' });
    await user.selectOptions(within(panel).getByLabelText('Microphone'), 'usb');
    expect(saveSettings).toHaveBeenCalledWith({ input_device_id: 'usb' });
    expect(within(panel).queryByLabelText('Translate to')).not.toBeInTheDocument();
    await user.selectOptions(within(panel).getByLabelText('Mode'), 'translation');
    expect(saveSettings).toHaveBeenCalledWith({ native_recording_mode: 'translation' });
    await user.selectOptions(within(panel).getByLabelText('Translate to'), 'de');
    expect(saveSettings).toHaveBeenCalledWith({ translation_target_language: 'de' });
    await user.click(within(panel).getByRole('checkbox', { name: /Include system audio/ }));
    expect(saveSettings).toHaveBeenCalledWith({ capture_system_audio: true });
    expect(panel).toHaveTextContent('Use headphones to avoid echo.');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rolls back and shows the error when saving fails', async () => {
    saveSettings.mockRejectedValueOnce(new Error('Could not save'));
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole('button', { name: 'Recording settings' }));
    const panel = screen.getByRole('dialog');
    await user.selectOptions(within(panel).getByLabelText('Mode'), 'translation');
    expect(within(panel).getByRole('alert')).toHaveTextContent('Could not save');
    expect(within(panel).getByLabelText('Mode')).toHaveValue('transcription');
  });

  it('locks everything while recording and names the reason', async () => {
    useStore.setState({ recorderState: 'recording' });
    const user = userEvent.setup(); show(true);
    expect(screen.getByRole('button', { name: 'Include system audio' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Include system audio' }));
    expect(saveSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Recording settings' }));
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveTextContent('Locked while recording');
    expect(within(panel).getByLabelText('Microphone')).toBeDisabled();
    expect(within(panel).getByRole('checkbox', { name: /Include system audio/ })).toBeDisabled();
  });

  it('while paused: sources editable, the session mode fixed and shown', async () => {
    useStore.setState({ recorderState: 'paused' });
    const user = userEvent.setup(); show(true);
    await user.click(screen.getByRole('button', { name: 'Recording settings' }));
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByLabelText('Microphone')).not.toBeDisabled();
    expect(within(panel).getByRole('checkbox', { name: /Include system audio/ })).not.toBeDisabled();
    await waitFor(() => expect(within(panel).getByLabelText('Mode')).toHaveValue('translation'));
    expect(within(panel).getByLabelText('Mode')).toBeDisabled();
    expect(within(panel).getByLabelText('Translate to')).toHaveValue('de');
    expect(panel).toHaveTextContent('Fixed for this session. New sessions use Settings.');
  });

  it('marks a saved microphone that is not connected', async () => {
    useStore.setState({ selectedDeviceId: 'airpods' });
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole('button', { name: 'Recording settings' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Saved microphone is not connected — recording uses the default one.');
  });

  it('disables system audio where the OS cannot capture it', async () => {
    window.skaz = { ...window.skaz, systemAudioSupported: false };
    show();
    const toggle = screen.getByRole('button', { name: 'Include system audio' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).toHaveAttribute('title', 'System audio requires macOS 14.2 or later');
  });
});
