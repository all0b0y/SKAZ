import { useStore } from '../../state/store';
import { SetupNotice } from '../ui/SetupNotice';
import { SETUP_MESSAGES, SETUP_SECTIONS, transcriptionSetupIssue } from '../../lib/transcriptionSetup';

/**
 * Why recording is unavailable, shown before the user tries it, with a button
 * into the settings section that fixes it: keys and cloud consent live under
 * API keys, the local model and provider choice under Transcription.
 */
export function TranscriptionSetupNotice() {
  const issue = useStore((s) => transcriptionSetupIssue(s.settings));
  if (!issue) return null;
  return <SetupNotice message={SETUP_MESSAGES[issue]} section={SETUP_SECTIONS[issue]} />;
}
