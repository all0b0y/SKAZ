import { describe, expect, it } from 'vitest';
import { transcriptionSetupIssue } from './transcriptionSetup';
import type { Settings } from '../api/types';

const settings = (over: Partial<Settings>): Settings => ({
  asr: { provider: 'openrouter', model: '' }, agent: { provider: 'openrouter', model: '' },
  notes: { provider: 'openrouter', model: '' }, transcript_language: 'auto', output_language: 'ru',
  cloud_consent: true, contextual_local_enabled: false, provider_has_api_key: { soniox: true }, ...over,
});

describe('transcriptionSetupIssue', () => {
  it('claims nothing while settings are unread', () => {
    expect(transcriptionSetupIssue(null)).toBeNull();
    expect(transcriptionSetupIssue(undefined)).toBeNull();
  });
  it('names a missing Soniox key first', () => {
    expect(transcriptionSetupIssue(settings({ provider_has_api_key: {}, cloud_consent: false }))).toBe('no-key');
    expect(transcriptionSetupIssue(settings({ provider_has_api_key: undefined }))).toBe('no-key');
  });
  it('names disabled cloud processing when the key is stored', () => {
    expect(transcriptionSetupIssue(settings({ cloud_consent: false }))).toBe('no-consent');
  });
  it('is ready with a key and consent', () => {
    expect(transcriptionSetupIssue(settings({}))).toBeNull();
  });
  it('never treats a Soniox key as a key for OpenAI', () => {
    expect(transcriptionSetupIssue(settings({ transcription_provider: 'openai' }))).toBe('no-openai-key');
    expect(transcriptionSetupIssue(settings({
      transcription_provider: 'openai', provider_has_api_key: { openai: true },
    }))).toBeNull();
    expect(transcriptionSetupIssue(settings({
      transcription_provider: 'openai', provider_has_api_key: { openai: true }, native_recording_mode: 'translation',
    }))).toBe('translation-unsupported');
  });
  it('lets Local Whisper record without keys or cloud consent once its model is ready', () => {
    const local = (ready: boolean) => settings({
      transcription_provider: 'local-whisper', provider_has_api_key: {}, cloud_consent: false,
      transcription_providers: [{
        id: 'local-whisper', label: 'Local Whisper', ready, models: [], limitations: [],
        capabilities: {
          live: 'near_streaming', provisional_text: true, file_transcription: true, speakers: 'approximate',
          translation: 'english_only', language_detection: 'selected_languages', word_timestamps: 'exact',
          offline: true, requires_cloud_consent: false,
        },
      }],
    });
    expect(transcriptionSetupIssue(local(false))).toBe('local-not-ready');
    expect(transcriptionSetupIssue(local(true))).toBeNull();
    expect(transcriptionSetupIssue({ ...local(true), native_recording_mode: 'translation', translation_target_language: 'de' }))
      .toBe('translation-unsupported');
    expect(transcriptionSetupIssue({ ...local(true), native_recording_mode: 'translation', translation_target_language: 'en' }))
      .toBeNull();
  });
});
