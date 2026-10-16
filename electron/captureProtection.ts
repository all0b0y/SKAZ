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

export interface QuitWarning {
  message: string;
  detail: string;
  /** [stay, quit]: the second one is the explicit choice to quit anyway. */
  buttons: [string, string];
}

/**
 * The quit confirmation in the words of the situation it is shown in. Quitting can't be confirmed
 * because audio is still being saved, because part of it couldn't be saved, or — nothing pending —
 * because the end of the recording (the last moment still inside the audio graph) was never
 * confirmed. Only the first two are called discarding audio: in the last one nothing is known lost.
 */
export function quitWarning(state: CaptureProtectionState): QuitWarning {
  if (state.failed > 0) {
    return {
      message: 'Some audio couldn’t be saved',
      detail: 'SKAZ couldn’t save part of the recording. Quitting now loses that part. '
        + 'Stay to retry saving, or discard it and quit.',
      buttons: ['Stay in SKAZ', 'Discard unsaved audio and quit'],
    };
  }
  if (state.pending > 0 || state.recorderState === 'recording' || state.recorderState === 'processing') {
    return {
      message: 'Audio is still being saved',
      detail: 'SKAZ is still saving the end of the recording. Quitting now may lose it. '
        + 'Stay until it is saved, or discard it and quit.',
      buttons: ['Stay in SKAZ', 'Discard unsaved audio and quit'],
    };
  }
  return {
    message: 'The end of the recording isn’t confirmed',
    detail: 'Everything SKAZ received is saved, but it couldn’t confirm the last moment before the '
      + 'recording stopped, so that moment may be missing. Stay in SKAZ, or quit anyway.',
    buttons: ['Stay in SKAZ', 'Quit anyway'],
  };
}
