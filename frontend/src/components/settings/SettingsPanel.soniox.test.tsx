import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../../api/bridge';
import type { Settings, SettingsUpdate } from '../../api/types';

// Public settings UI → production store/client → external preload boundary.
let SettingsPanel: (typeof import('./SettingsPanel'))['SettingsPanel'];
let requests: BridgeRequest[];
let saved: Settings;
let refuse: boolean;
beforeEach(async () => {
  vi.resetModules();
  requests = [];
  refuse = false;
  saved = {
    asr: { provider: 'local-whisper', model: 'small' },
    agent: { provider: 'openrouter', model: 'agent' },
    notes: { provider: 'openrouter', model: 'notes' },
    transcript_language: 'auto', output_language: 'ru',
    cloud_consent: false, contextual_local_enabled: false,
    used_languages: null, supported_languages: ['ru', 'en', 'de'],
  };
  const request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
    requests.push(req);
    if (req.path === '/settings') {
      if (req.method === 'PUT') {
        if (refuse) return { ok: false, status: 503, detail: 'Secure storage unavailable.' };
        const update = req.body as SettingsUpdate;
        saved = {
          ...saved,
          native_recording_mode: update.native_recording_mode ?? saved.native_recording_mode,
          translation_target_language: update.translation_target_language ?? saved.translation_target_language,
          used_languages: update.used_languages ?? saved.used_languages,
          cloud_consent: update.cloud_consent ?? saved.cloud_consent,
          ...('soniox_api_key' in update ? { soniox_has_api_key: Boolean(update.soniox_api_key) } : {}),
        };
      }
      return { ok: true, status: 200, data: saved as T };
    }
    return { ok: false, status: 404, detail: 'No fixture for this endpoint.' };
  };
  window.audiohelper = { ...window.audiohelper, request } satisfies BridgeApi;
  const { useStore } = await import('../../state/store');
  await act(async () => { await useStore.getState().refreshSettings(); });
  SettingsPanel = (await import('./SettingsPanel')).SettingsPanel;
});

const writes = () => requests.filter((r) => r.method === 'PUT' && r.path === '/settings');

describe('Soniox credentials and explicit consent', () => {
  it('saves translation and its target for new recordings without granting consent', async () => {
    const user = userEvent.setup();
    const view = render(<SettingsPanel onClose={() => {}} />);
    await user.selectOptions(screen.getByLabelText('Режим новой записи'), 'translation');
    await user.selectOptions(screen.getByLabelText('Язык перевода'), 'de');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes()[0]?.body).toEqual({ native_recording_mode: 'translation', translation_target_language: 'de' });
    expect(saved.cloud_consent).toBe(false);
    view.unmount();
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByLabelText('Режим новой записи')).toHaveValue('translation');
    expect(screen.getByLabelText('Язык перевода')).toHaveValue('de');
    await user.selectOptions(screen.getByLabelText('Режим новой записи'), 'transcription');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes()[1]?.body).toEqual({ native_recording_mode: 'transcription' });
    expect(saved.translation_target_language).toBe('de');
  });

  it('selects several used languages, prevents empty saves, and retains selection on reopening', async () => {
    const user = userEvent.setup();
    const view = render(<SettingsPanel onClose={() => {}} />);
    expect(screen.queryByLabelText('Transcript language')).not.toBeInTheDocument();
    await user.click(screen.getByText('Выбрать языки'));
    await user.click(screen.getByRole('checkbox', { name: 'Русский' }));
    await user.click(screen.getByRole('checkbox', { name: 'Английский' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes()[0]?.body).toEqual({ used_languages: ['ru', 'en'] });
    view.unmount();
    render(<SettingsPanel onClose={() => {}} />);
    await user.click(screen.getByText('Русский, Английский'));
    expect(screen.getByRole('checkbox', { name: 'Русский' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Английский' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Русский' }));
    await user.click(screen.getByRole('checkbox', { name: 'Английский' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Выбрать все' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes()[1]?.body).toEqual({ used_languages: ['ru', 'en', 'de'] });
  });

  it('preserves consent on unrelated saves and requires an explicit grant or revoke', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes()[0]?.body).toEqual({});
    await user.click(screen.getByRole('button', { name: 'API keys' }));
    const consent = screen.getByRole('checkbox', { name: /Allow cloud processing/ });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes()[1]?.body).toEqual({ cloud_consent: true });
    expect(consent).toBeChecked();
    await user.click(consent);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes()[2]?.body).toEqual({ cloud_consent: false });
    expect(consent).not.toBeChecked();
  });

  it('reports failed storage without claiming success, then supports retry and explicit removal', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'API keys' }));
    const input = screen.getByLabelText('Soniox API key');
    await user.type(input, 'soniox-fixture-only');
    refuse = true;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Secure storage unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(/Soniox key stored\./)).not.toBeInTheDocument();
    expect(input).toHaveValue('soniox-fixture-only');
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/Soniox key stored\./);
    expect(input).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Remove Soniox key' }));
    expect(screen.getByText(/will be removed on Save/)).toBeInTheDocument();
    expect(writes()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/No Soniox key stored/);
    expect(writes()[2]?.body).toEqual({ soniox_api_key: '' });
  });

  it('saves a masked Soniox key without changing ASR profiles or granting cloud consent', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'API keys' }));
    const input = screen.getByLabelText('Soniox API key');
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, 'soniox-fixture-only');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/Soniox key stored/i);
    expect(writes().map((r) => r.body)).toEqual([{ soniox_api_key: 'soniox-fixture-only' }]);
    expect(input).toHaveValue('');
    expect(localStorage.getItem('soniox_api_key')).toBeNull();
    expect(sessionStorage.getItem('soniox_api_key')).toBeNull();
  });
});
