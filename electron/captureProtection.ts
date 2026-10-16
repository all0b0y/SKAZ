// Decides whether closing the window / quitting would lose captured audio that
// has not yet been persisted by the backend. The renderer reports its live
// capture state to main over IPC; main consults this before honoring a close so
// it can warn the user instead of silently dropping unsent speech
// (docs/DESKTOP-REVIEW-NOTES.md: "не терять речь молча").
import type { CaptureState } from '../frontend/src/api/bridge';

export type CaptureProtectionState = CaptureState;

/**
 * True when there is audio in flight worth protecting: an active/draining
 * capture, chunks still pending upload, or failed chunks retained for retry.
 */
export function hasUnsentAudio(state: CaptureProtectionState): boolean {
  return (
    state.recorderState === 'recording' ||
    state.recorderState === 'processing' ||
    state.pending > 0 ||
    state.failed > 0
  );
}
