import type { Settings } from '../api/types';
import type { SectionId } from '../components/settings/SettingsPanel';

export type TranscriptionSetupIssue =
  | 'no-key'
  | 'no-consent'
  | 'no-openai-key'
  | 'local-not-ready'
  | 'translation-unsupported';

/**
 * Why live transcription cannot run, or null when it can. The backend opens the
 * selected provider only when its requirements hold (routes/live.py): Soniox and
 * OpenAI need their own key AND cloud consent; Local Whisper needs its model on
 * disk and no consent. There is never a fallback to another provider, so a
 * recording started without them would silently produce audio only.
 *
 * Null while settings are unread: an unloaded document is not "not configured",
 * and claiming so would block recording on every cold start.
 */
export function transcriptionSetupIssue(settings: Settings | null | undefined): TranscriptionSetupIssue | null {
  if (!settings) return null;
  const provider = settings.transcription_provider ?? 'soniox';
  const translating = settings.native_recording_mode === 'translation';
  if (provider === 'soniox') {
    if (settings.provider_has_api_key?.soniox !== true) return 'no-key';
    if (!settings.cloud_consent) return 'no-consent';
    return null;
  }
  if (provider === 'openai') {
    if (settings.provider_has_api_key?.openai !== true) return 'no-openai-key';
    if (!settings.cloud_consent) return 'no-consent';
    if (translating) return 'translation-unsupported';
    return null;
  }
  const info = settings.transcription_providers?.find((item) => item.id === provider);
  if (info && !info.ready) return 'local-not-ready';
  if (translating && (settings.translation_target_language ?? 'ru') !== 'en') return 'translation-unsupported';
  return null;
}

/** Short reason shown on the disabled record control. */
export const SETUP_HINTS: Record<TranscriptionSetupIssue, string> = {
  'no-key': 'No Soniox key',
  'no-consent': 'Cloud processing is off',
  'no-openai-key': 'No OpenAI key',
  'local-not-ready': 'Local model not downloaded',
  'translation-unsupported': 'Translation not supported',
};

/** Full sentence for the notice above the transcript. */
export const SETUP_MESSAGES: Record<TranscriptionSetupIssue, string> = {
  'no-key': 'Transcription is not set up — add a Soniox API key in Settings.',
  'no-consent': 'Transcription is not set up — cloud processing is off. Turn it on in Settings.',
  'no-openai-key': 'Transcription is not set up — add an OpenAI API key in Settings, or choose another provider.',
  'local-not-ready': 'Local Whisper is selected, but its model is not ready — download it in Settings → Transcription.',
  'translation-unsupported':
    'The selected transcription provider cannot translate into this language. Local Whisper translates into English only; '
    + 'OpenAI does not translate live. Change the recording mode or provider in Settings.',
};

/** The settings section holding the one control that fixes the issue. */
export const SETUP_SECTIONS: Record<TranscriptionSetupIssue, SectionId> = {
  'no-key': 'api-keys',
  'no-consent': 'api-keys',
  'no-openai-key': 'api-keys',
  'local-not-ready': 'asr',
  'translation-unsupported': 'asr',
};
