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
});
