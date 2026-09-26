import { useStore } from '../../state/store';
import { SetupNotice } from '../ui/SetupNotice';
import { SETUP_MESSAGES, transcriptionSetupIssue } from '../../lib/transcriptionSetup';

/**
 * Why recording is unavailable, shown before the user tries it. Both reasons
 * are fixed in the API keys section: the Soniox key and the cloud-processing
 * consent live there together.
 */
export function TranscriptionSetupNotice() {
  const issue = useStore((s) => transcriptionSetupIssue(s.settings));
  if (!issue) return null;
  return <SetupNotice message={SETUP_MESSAGES[issue]} section="api-keys" />;
}
