import type { Settings } from '../api/types';

export type TranscriptionSetupIssue = 'no-key' | 'no-consent';

/**
 * Why live transcription cannot run, or null when it can. The backend opens a
 * Soniox stream only with a stored key AND cloud consent (routes/live.py), so
 * a recording started without either would silently produce audio only.
 *
 * Null while settings are unread: an unloaded document is not "not configured",
 * and claiming so would block recording on every cold start.
 */
export function transcriptionSetupIssue(settings: Settings | null | undefined): TranscriptionSetupIssue | null {
  if (!settings) return null;
  if (settings.provider_has_api_key?.soniox !== true) return 'no-key';
  if (!settings.cloud_consent) return 'no-consent';
  return null;
}

/** Short reason shown on the disabled record control. */
export const SETUP_HINTS: Record<TranscriptionSetupIssue, string> = {
  'no-key': 'No Soniox key',
  'no-consent': 'Cloud processing is off',
};

/** Full sentence for the notice above the transcript. */
export const SETUP_MESSAGES: Record<TranscriptionSetupIssue, string> = {
  'no-key': 'Transcription is not set up — add a Soniox API key in Settings.',
  'no-consent': 'Transcription is not set up — cloud processing is off. Turn it on in Settings.',
};
