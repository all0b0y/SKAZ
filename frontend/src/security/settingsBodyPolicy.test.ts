import { describe, expect, it } from 'vitest';
import { RENDERER_SETTINGS_FIELDS, validateBridgeRequest } from '../../../electron/ipcPolicy';

// Final review M5: the renderer may PUT /settings only with the recording options it actually sends
// (kb/recording/recordingStore.ts setOptions). Consent, keys and providers go through their own
// routes and dialogs (/kb/settings/keys, /kb/settings/speech, /kb/decisions/provider), never here.
const put = (body: unknown) => validateBridgeRequest({ method: 'PUT', path: '/settings', body });

describe('PUT /settings from the renderer', () => {
  it('passes the four recording options the UI sends', () => {
    expect([...RENDERER_SETTINGS_FIELDS].sort()).toEqual(
      ['capture_system_audio', 'input_device_id', 'native_recording_mode', 'translation_target_language']);
    expect(put({ native_recording_mode: 'translation', translation_target_language: 'de' })).toBeNull();
    expect(put({ input_device_id: 'mic-2', capture_system_audio: true })).toBeNull();
    expect(put({})).toBeNull();
  });

  it('refuses consent, keys and providers, alone or smuggled next to an allowed field', () => {
    for (const body of [
      { cloud_consent: true },
      { provider_api_keys: { openai: 'sk-x' } },
      { transcription_provider: 'openai' },
      { asr: { provider: 'openrouter', model: 'x' } },
      { native_recording_mode: 'transcription', cloud_consent: true },
      { input_device_id: 'mic', openai_transcription_model: 'whisper-1' },
    ]) expect(put(body), JSON.stringify(body)).toMatch(/not allowed/);
  });

  it('refuses a body that is not a plain object', () => {
    for (const body of [null, [], 'cloud_consent', 1]) expect(put(body), String(body)).toMatch(/not allowed|object/);
  });

  it('leaves other routes alone', () => {
    expect(validateBridgeRequest({ method: 'PUT', path: '/kb/settings/wiki', body: { auto_add_text: true } })).toBeNull();
  });
});
