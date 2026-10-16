import type { RecorderState } from '../audio/recorder';

/**
 * Capture sources (microphone, system audio) change only between recording
 * stretches: before start and while paused. `processing` covers the short
 * start/pause/resume/stop transitions, when the capture graph is being built
 * or torn down (.dev/docs/CAPTURE-SOURCES-BULK-SPEC.md §2).
 */
export function captureSourcesLocked(state: RecorderState): boolean {
  return state === 'recording' || state === 'processing';
}
